// contact.js — wire contact form to /api/submitContactForm
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('contactForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('contact_name').value.trim();
    const message = document.getElementById('contact_message').value.trim();
    if (!name || !message) return alert('Name and message required');
    try {
      const res = await API.post('/api/submitContactForm', { name, email: name, message });
      if (res && res.success) {
        alert('Message sent — id: ' + res.id);
        form.reset();
      } else {
        alert('Error: ' + (res.error || JSON.stringify(res)));
      }
    } catch (err) {
      console.error(err); alert('Failed to send message');
    }
  });
});
