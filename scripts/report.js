// report.js — wire report form to submitLostItem / submitFoundItem
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('reportForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const payload = {
      reporter_name: data.get('reporter_name'),
      contact: data.get('contact') || data.get('reporter_name'),
      item_title: data.get('item_title'),
      category: data.get('category'),
      description: data.get('description'),
      image_url: data.get('image_url') || null
    };
    // selected type
    const type = form.querySelector('input[name="type"]:checked').value;
    const endpoint = type === 'found' ? '/api/submitFoundItem' : '/api/submitLostItem';
    try {
      const res = await API.post(endpoint, payload);
      if (res && res.success) {
        alert('Submitted — id: ' + res.id);
        form.reset();
      } else {
        alert('Error: ' + (res.error || JSON.stringify(res)));
      }
    } catch (err) {
      console.error(err); alert('Submission failed');
    }
  });
});
