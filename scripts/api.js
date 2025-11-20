// Lightweight API helper for the frontend
const API = (function(){
  async function post(path, body){
    const res = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    return res.json();
  }

  async function get(path){
    const res = await fetch(path);
    return res.json();
  }

  return { post, get };
})();

window.API = API;
