// search.js — simple search wiring
document.addEventListener('DOMContentLoaded', ()=>{
  const input = document.getElementById('search_input');
  const btn = document.getElementById('search_btn');
  btn.addEventListener('click', async ()=>{
    const q = input.value.trim();
    if (!q) return alert('Enter search term');
    try{
      // Use searchItems via GET with item_name
      const res = await API.get(`/api/searchItems?item_name=${encodeURIComponent(q)}&type=all`);
      if (!res || !res.items) return alert('No results');
      // reuse dashboard rendering: show results on itemsContainer if present
      const container = document.getElementById('itemsContainer');
      if (container){
        container.innerHTML = '';
        res.items.forEach(item=>{
          const div = document.createElement('div');
          div.className = 'bg-white bg-opacity-90 dark:bg-gray-800 dark:bg-opacity-80 shadow rounded-xl p-4 backdrop-blur-md transition-colors duration-500';
          div.innerHTML = `
            ${item.image_url ? `<img src="${item.image_url}" alt="${item.item_title}" class="rounded mb-3">` : ''}
            <h3 class="font-semibold text-lg text-gray-800 dark:text-gray-200">${item.item_title || 'Untitled'}</h3>
            <p class="text-gray-600 dark:text-gray-400 text-sm">${item.description || ''}</p>
          `;
          container.appendChild(div);
        });
      } else {
        console.log('Search results', res.items);
        alert(`Found ${res.count} items — see console`);
      }
    }catch(err){ console.error(err); alert('Search failed'); }
  });
});
