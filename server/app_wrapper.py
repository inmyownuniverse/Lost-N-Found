# app_wrapper.py
from flask import Flask, request
import main  # make sure main.py is in the same folder

app = Flask(__name__)

@app.route("/api/submitLostItem", methods=["POST", "OPTIONS"])
def submit_lost():
    return main.submitLostItem(request)

@app.route("/api/submitFoundItem", methods=["POST", "OPTIONS"])
def submit_found():
    return main.submitFoundItem(request)

@app.route("/api/getItems", methods=["GET", "POST", "OPTIONS"])
def get_items():
    return main.getItems(request)

@app.route("/api/searchItems", methods=["GET", "POST", "OPTIONS"])
def search_items():
    return main.searchItems(request)

@app.route("/api/submitContactForm", methods=["POST", "OPTIONS"])
def submit_contact():
    return main.submitContactForm(request)

@app.route("/api/getItemDetails", methods=["GET", "POST", "OPTIONS"])
def get_item_details():
    return main.getItemDetails(request)


@app.route("/api/sendMessage", methods=["POST", "OPTIONS"])
def send_message():
    return main.sendMessage(request)


@app.route("/api/getMessages", methods=["GET", "POST", "OPTIONS"])
def get_messages():
    return main.getMessages(request)


@app.route("/api/streamMessages", methods=["GET"])
def stream_messages():
    return main.streamMessages(request)


@app.route("/api/getConversations", methods=["GET", "OPTIONS"])
def get_conversations():
    return main.getConversations(request)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
