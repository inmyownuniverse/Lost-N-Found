// dashboard.js — fetch items and render cards
async function renderItems(){
  try{
    const res = await API.get('/api/getItems?type=all&limit=50');
    const container = document.getElementById('itemsContainer');
    container.innerHTML = '';
    if(!res || !res.items) return container.innerHTML = '<p class="text-center">No items found</p>';
    res.items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'bg-white bg-opacity-90 dark:bg-gray-800 dark:bg-opacity-80 shadow rounded-xl p-4 backdrop-blur-md transition-colors duration-500';
      div.innerHTML = `
        ${item.image_url ? `<img src="${item.image_url}" alt="${item.item_title}" class="rounded mb-3">` : ''}
        <h3 class="font-semibold text-lg text-gray-800 dark:text-gray-200">${item.item_title || 'Untitled'}</h3>
        <p class="text-gray-600 dark:text-gray-400 text-sm">${item.description || ''}</p>
        <div class="mt-3 flex gap-2">
          <button class="claimBtn bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">Claim</button>
          <a class="viewLink underline text-sm" href="#">View</a>
        </div>
      `;
      container.appendChild(div);
    });
  }catch(err){ console.error(err); }
}

document.addEventListener('DOMContentLoaded', renderItems);
