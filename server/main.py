# main.py
# Deploy each function as an HTTP Cloud Function in GCP.
# Example entry points (function names): submitLostItem, submitFoundItem, getItems, searchItems, submitContactForm, getItemDetails

import json
import os
import traceback
from datetime import datetime
from typing import Optional
import time
import queue
import threading

from google.cloud import firestore
from google.auth.exceptions import DefaultCredentialsError
from google.oauth2 import service_account
from flask import Request, jsonify, make_response, Response, stream_with_context

# Initialize Firestore client (uses GOOGLE_APPLICATION_CREDENTIALS or default service account in GCP)
def make_firestore_client():
    """
    Create a Firestore client. Prefer Application Default Credentials, but
    fall back to a local `serviceAccountKey.json` file if ADC are not available.
    """
    try:
        return firestore.Client()
    except DefaultCredentialsError:
        # Try loading a local service account key in the same directory as this file
        key_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
        if os.path.exists(key_path):
            creds = service_account.Credentials.from_service_account_file(key_path)
            project = getattr(creds, "project_id", None)
            return firestore.Client(project=project, credentials=creds)
        # Re-raise the original error to surface useful guidance
        raise


# Initialize Firestore client (uses GOOGLE_APPLICATION_CREDENTIALS or default service account in GCP)
db = make_firestore_client()

# Helper utils
def json_response(payload, status=200):
    resp = make_response(jsonify(payload), status)
    resp.headers["Content-Type"] = "application/json"
    # Allow CORS for testing. In production restrict allowed origins.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp

def handle_options(request: Request):
    # Preflight CORS handler
    if request.method == "OPTIONS":
        return json_response({"status": "ok"}, 204)
    return None

def parse_json_request(request: Request):
    try:
        data = request.get_json(force=True, silent=False)
        if data is None:
            raise ValueError("Empty JSON")
        return data
    except Exception as e:
        raise ValueError(f"Invalid JSON body: {e}")

def now_iso():
    return datetime.utcnow().isoformat() + "Z"

def save_document(collection: str, data: dict) -> str:
    """
    Adds a document to `collection`, returns the document id.
    """
    coll_ref = db.collection(collection)
    doc_ref = coll_ref.document()  # auto-id
    doc_ref.set(data)
    return doc_ref.id


# -----------------------------
# Chat helpers & endpoints
# -----------------------------
def sendMessage(request: Request):
    """
    Save a chat message in Firestore.
    Expects JSON: { "conversation_id": "<id>", "sender": "Alice", "text": "...", "item": {"title":"...","link":"..."} }
    If `conversation_id` is omitted, a new conversation doc is created and its id returned along with the message id.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        body = parse_json_request(request)
        sender = body.get("sender")
        text = body.get("text", "").strip()
        conv_id = body.get("conversation_id")
        item = body.get("item")

        if not sender or not text:
            return json_response({"error": "sender and text are required"}, 400)

        now_ts = int(time.time() * 1000)

        # If no conversation id provided, create one
        if not conv_id:
            conv_doc = db.collection("conversations").document()
            conv_id = conv_doc.id
            conv_doc.set({"created_at": now_iso(), "updated_at": now_iso(), "last_message": None})

        msgs_coll = db.collection("conversations").document(conv_id).collection("messages")
        msg_doc = msgs_coll.document()
        msg_payload = {
            "sender": sender,
            "text": text,
            "time": now_ts,
        }
        if item:
            msg_payload["item"] = item

        msg_doc.set(msg_payload)

        # Update conversation metadata
        db.collection("conversations").document(conv_id).update({
            "last_message": text,
            "updated_at": now_iso(),
        })

        return json_response({"success": True, "conversation_id": conv_id, "message_id": msg_doc.id}, 201)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)


def getMessages(request: Request):
    """
    Retrieve messages for a conversation.
    GET query param: ?conversation_id=<id>&limit=100
    POST body: {"conversation_id":"...","limit":100}
    Returns messages ordered ascending by `time`.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        if request.method == "GET":
            q = request.args
            conv_id = q.get("conversation_id")
            limit = int(q.get("limit", 200))
        else:
            body = parse_json_request(request)
            conv_id = body.get("conversation_id")
            limit = int(body.get("limit", 200))

        if not conv_id:
            return json_response({"error": "conversation_id is required"}, 400)

        msgs = db.collection("conversations").document(conv_id).collection("messages").order_by("time").limit(limit).stream()
        out = [{**doc.to_dict(), "id": doc.id} for doc in msgs]
        return json_response({"messages": out, "count": len(out)}, 200)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)


def getConversations(request: Request):
    """
    Return recent conversations with metadata (id, last_message, updated_at).
    GET params: ?limit=50
    """
    options = handle_options(request)
    if options:
        return options
    try:
        limit = int(request.args.get('limit', 50))
        docs = db.collection('conversations').order_by('updated_at', direction=firestore.Query.DESCENDING).limit(limit).stream()
        out = []
        for doc in docs:
            d = doc.to_dict() or {}
            out.append({
                'id': doc.id,
                'last_message': d.get('last_message'),
                'updated_at': d.get('updated_at')
            })
        return json_response({'conversations': out, 'count': len(out)}, 200)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)


def streamMessages(request: Request):
    """
    SSE endpoint that streams real-time message updates for a conversation using Firestore listener.
    Connect with EventSource to `/api/streamMessages?conversation_id=<id>`.
    """
    conv_id = request.args.get("conversation_id")
    if not conv_id:
        return json_response({"error": "conversation_id query param required"}, 400)

    msgs_coll = db.collection("conversations").document(conv_id).collection("messages")

    q = queue.Queue()

    def on_snapshot(col_snapshot, changes, read_time):
        for change in changes:
            try:
                doc = change.document
                payload = {"id": doc.id, **doc.to_dict(), "type": change.type.name}
                q.put(json.dumps(payload))
            except Exception:
                traceback.print_exc()

    # Start listener
    query_watch = msgs_coll.order_by("time")
    stop_event = threading.Event()

    # attach listener in a separate thread because on_snapshot can block
    listener = query_watch.on_snapshot(on_snapshot)

    def gen():
        try:
            # send an initial ping
            yield "event: ping\n\ndata: {}\n\n"
            while not stop_event.is_set():
                try:
                    item = q.get(timeout=15)
                    # SSE format
                    yield f"data: {item}\n\n"
                except queue.Empty:
                    # send keep-alive comment to avoid timeouts
                    yield ": keep-alive\n\n"
        finally:
            try:
                listener.unsubscribe()
            except Exception:
                pass

    return Response(stream_with_context(gen()), mimetype="text/event-stream")

def add_common_fields(data: dict, extra: Optional[dict] = None) -> dict:
    base = {
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    if extra:
        base.update(extra)
    base.update(data)
    return base

# 1) submitLostItem
def submitLostItem(request: Request):
    """
    Expects JSON body with at least:
    {
      "reporter_name": "Alice",
      "contact": "alice@example.com or phone",
      "item_title": "Black wallet",
      "category": "wallet",
      "description": "lost near canteen",
      "image_url": "https://..."   # optional
    }
    """
    options = handle_options(request)
    if options:
        return options

    try:
        payload = parse_json_request(request)
        # Validate minimal fields
        required = ["reporter_name", "contact", "item_title", "category"]
        missing = [r for r in required if r not in payload or not str(payload.get(r)).strip()]
        if missing:
            return json_response({"error": "Missing fields", "missing": missing}, 400)

        item = add_common_fields(payload, {"status": "lost", "type": "lost"})
        doc_id = save_document("items_lost", item)
        return json_response({"success": True, "id": doc_id}, 201)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)

# 2) submitFoundItem
def submitFoundItem(request: Request):
    """
    Same schema as submitLostItem, but saves to found collection and sets status to 'found'.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        payload = parse_json_request(request)
        required = ["reporter_name", "contact", "item_title", "category"]
        missing = [r for r in required if r not in payload or not str(payload.get(r)).strip()]
        if missing:
            return json_response({"error": "Missing fields", "missing": missing}, 400)

        item = add_common_fields(payload, {"status": "found", "type": "found"})
        doc_id = save_document("items_found", item)
        return json_response({"success": True, "id": doc_id}, 201)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)

# 3) getItems
def getItems(request: Request):
    """
    Query params (optional):
      ?type=lost|found|all
      ?limit=20
      ?pageToken=<last_doc_id>   (simple pagination: return documents after this id - note: Firestore cursor by document id requires extra steps; this implementation supports 'limit' only for simplicity)
    Returns combined list when type=all or omitted (both collections).
    """
    options = handle_options(request)
    if options:
        return options

    try:
        q = request.args
        typ = q.get("type", "all").lower()
        limit = int(q.get("limit", 50))

        results = []
        def fetch_collection(coll_name, limit):
            docs = db.collection(coll_name).order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit).stream()
            return [{**doc.to_dict(), "id": doc.id, "_collection": coll_name} for doc in docs]

        if typ in ("lost", "all"):
            results.extend(fetch_collection("items_lost", limit))
        if typ in ("found", "all"):
            results.extend(fetch_collection("items_found", limit))

        # Sort combined by created_at descending
        results.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        return json_response({"items": results, "count": len(results)}, 200)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)

# 4) searchItems
def searchItems(request: Request):
    """
    POST or GET:
    Query params (GET): ?category=wallet&item_name=wallet
    Body (POST): {"category":"wallet", "item_name":"black wallet", "type":"lost|found|all"}
    Note: Firestore doesn't support full-text search. For lightweight partial-match we do a simple case-insensitive contains on client side after fetching a small set by category.
    For production use integrate with Algolia / Elastic / Firebase App Check + Firestore text indexes.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        if request.method == "GET":
            q = request.args
            category = q.get("category")
            item_name = q.get("item_name")
            typ = q.get("type", "all")
        else:
            body = parse_json_request(request)
            category = body.get("category")
            item_name = body.get("item_name")
            typ = body.get("type", "all")

        if not category and not item_name:
            return json_response({"error": "Provide at least category or item_name to search"}, 400)

        def fetch_and_filter(coll_name):
            # If category is present, query server-side by category equality (fast).
            results = []
            if category:
                docs = db.collection(coll_name).where("category", "==", category).stream()
                results = [{**doc.to_dict(), "id": doc.id, "_collection": coll_name} for doc in docs]
            else:
                # fallback: fetch last N docs from collection and filter locally
                docs = db.collection(coll_name).order_by("created_at", direction=firestore.Query.DESCENDING).limit(200).stream()
                results = [{**doc.to_dict(), "id": doc.id, "_collection": coll_name} for doc in docs]

            # local filtering for item_name (case-insensitive contains)
            if item_name:
                term = item_name.strip().lower()
                results = [r for r in results if term in (r.get("item_title","").lower() + " " + r.get("description","").lower())]
            return results

        results = []
        if typ in ("lost","all"):
            results.extend(fetch_and_filter("items_lost"))
        if typ in ("found","all"):
            results.extend(fetch_and_filter("items_found"))

        # Sort by created_at desc
        results.sort(key=lambda r: r.get("created_at",""), reverse=True)
        return json_response({"items": results, "count": len(results)}, 200)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)

# 5) submitContactForm
def submitContactForm(request: Request):
    """
    Expects JSON:
      { "name": "...", "email": "...", "message": "...", "phone": "optional" }
    Saves to 'contacts' collection.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        payload = parse_json_request(request)
        required = ["name", "email", "message"]
        missing = [r for r in required if r not in payload or not str(payload.get(r)).strip()]
        if missing:
            return json_response({"error": "Missing fields", "missing": missing}, 400)

        doc = add_common_fields(payload)
        doc_id = save_document("contacts", doc)
        return json_response({"success": True, "id": doc_id}, 201)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)

# 6) getItemDetails (optional)
def getItemDetails(request: Request):
    """
    GET or POST:
      Query params: ?collection=lost|found&id=<doc_id>
      OR JSON body: {"collection":"lost","id":"<doc_id>"}
    Returns document data with id.
    """
    options = handle_options(request)
    if options:
        return options

    try:
        if request.method == "GET":
            q = request.args
            collection = q.get("collection")
            doc_id = q.get("id")
        else:
            body = parse_json_request(request)
            collection = body.get("collection")
            doc_id = body.get("id")

        if not collection or not doc_id:
            return json_response({"error": "collection and id are required"}, 400)

        coll_name = "items_lost" if collection.lower() in ("lost","items_lost") else "items_found"
        doc_ref = db.collection(coll_name).document(doc_id)
        doc = doc_ref.get()
        if not doc.exists:
            return json_response({"error": "Not found"}, 404)

        data = doc.to_dict()
        data["id"] = doc.id
        data["_collection"] = coll_name
        return json_response({"item": data}, 200)
    except ValueError as e:
        return json_response({"error": str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return json_response({"error": "Internal server error", "detail": str(e)}, 500)
