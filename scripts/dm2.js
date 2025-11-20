(function(){
  // DM client: syncs messages with server. Local conversations stored in localStorage; when a conversation sends its first message
  // we create a server-side conversation and migrate to use the server for messages and real-time SSE.
  const STORAGE_KEY = 'lnf_dm_data_v1'
  const currentUser = { id: 'me', name: 'You' }

  const defaultData = {
    conversations: [],
    selectedConversationId: null
  }

  function load(){
    try{ const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : defaultData }catch(e){ console.error(e); return defaultData }
  }
  function save(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }

  // DOM refs
  const convList = document.getElementById('conversationsList')
  const convTmpl = document.getElementById('convItemTmpl')
  const msgTmpl = document.getElementById('msgTmpl')
  const messagesEl = document.getElementById('messages')
  const chatHeader = document.getElementById('chatHeader')
  const titleEl = chatHeader.querySelector('.chat-title')
  const form = document.getElementById('messageForm')
  const input = document.getElementById('messageInput')
  const attachBtn = document.getElementById('attachItemBtn')
  const newConvBtn = document.getElementById('newConvBtn')

  const itemModal = document.getElementById('itemModal')
  const itemTitle = document.getElementById('itemTitle')
  const itemLink = document.getElementById('itemLink')
  const cancelItem = document.getElementById('cancelItem')
  const attachItem = document.getElementById('attachItem')

  let state = load()
  if(!state.selectedConversationId && state.conversations.length) state.selectedConversationId = state.conversations[0].id

  // track SSE EventSource
  let es = null

  function isServerConvId(id){ return id && !id.startsWith('local-') }

  function renderConversations(){
    convList.innerHTML = ''
    state.conversations.forEach(c=>{
      const li = convTmpl.content.firstElementChild.cloneNode(true)
      li.dataset.id = c.id
      li.querySelector('.avatar').textContent = initials(c.name||c.id)
      li.querySelector('.name').textContent = c.name || c.id
      const last = c.messages && c.messages.length ? c.messages[c.messages.length-1] : null
      li.querySelector('.snippet').textContent = last ? (last.text.slice(0,60)) : 'No messages yet'
      li.querySelector('.time').textContent = last ? timeAgo(last.time) : ''
      li.addEventListener('click', ()=>{ selectConversation(c.id) })
      if(c.id === state.selectedConversationId) li.classList.add('active')
      convList.appendChild(li)
    })
  }

  function renderMessages(){
    const conv = state.conversations.find(x=>x.id === state.selectedConversationId)
    messagesEl.innerHTML = ''
    if(!conv){ titleEl.textContent = 'Select a conversation'; return }
    titleEl.textContent = conv.name || conv.id
    conv.messages.forEach(m=>{
      const node = msgTmpl.content.firstElementChild.cloneNode(true)
      node.dataset.id = m.id
      node.classList.toggle('me', m.sender === currentUser.name || m.sender === currentUser.id)
      node.querySelector('.avatar').textContent = initials(m.sender)
      node.querySelector('.sender').textContent = m.sender
      node.querySelector('.text').textContent = m.text || ''
      const itemRef = node.querySelector('.item-ref')
      if(m.item){
        const a = document.createElement('a')
        a.textContent = m.item.title
        a.href = m.item.link || '#'
        a.style.color = 'var(--accent)'
        itemRef.appendChild(a)
      } else { itemRef.remove() }
      node.querySelector('.ts').textContent = new Date(m.time).toLocaleString()
      messagesEl.appendChild(node)
    })
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function selectConversation(id){
    // unsubscribe previous SSE
    if(es){ es.close(); es = null }
    state.selectedConversationId = id
    save(state)
    renderConversations()
    const conv = state.conversations.find(x=>x.id===id)
    if(isServerConvId(id)){
      // fetch server messages and subscribe
      API.get(`/api/getMessages?conversation_id=${encodeURIComponent(id)}&limit=500`).then(res=>{
        if(res && res.messages){
          conv.messages = res.messages.map(m => ({ id: m.id, sender: m.sender, text: m.text, time: m.time, item: m.item }))
          save(state); renderMessages();
          subscribeSSE(id)
        }
      }).catch(err=>{ console.error(err); renderMessages(); })
    } else {
      renderMessages()
    }
  }

  function subscribeSSE(convId){
    es = new EventSource(`/api/streamMessages?conversation_id=${encodeURIComponent(convId)}`)
    es.onmessage = (e)=>{
      try{
        const payload = JSON.parse(e.data)
        // add to current conversation if matches
        const conv = state.conversations.find(x=>x.id===convId)
        if(!conv) return
        // ignore keep-alive or ping without data
        if(!payload || !payload.id) return
        conv.messages.push({ id: payload.id, sender: payload.sender, text: payload.text, time: payload.time, item: payload.item })
        save(state); renderMessages();
      }catch(err){ console.error('SSE parse', err) }
    }
    es.onerror = (err)=>{ console.error('SSE error', err) }
  }

  async function sendMessageToServer(conv, text, item){
    // if conv has server id, include; otherwise create server conv by omitting conversation_id
    const body = { sender: currentUser.name, text }
    if(item) body.item = item
    if(isServerConvId(conv.id)) body.conversation_id = conv.id
    const res = await API.post('/api/sendMessage', body)
    if(res && res.success){
      // if server created new conversation, migrate local id
      if(!isServerConvId(conv.id) && res.conversation_id){
        // replace local conv id with server id
        const oldId = conv.id
        conv.id = res.conversation_id
        // update stored state
        state.conversations = state.conversations.map(c => c === conv ? conv : c)
        save(state)
        // re-select using new id
        selectConversation(conv.id)
      }
      return res
    } else throw new Error(JSON.stringify(res))
  }

  function sendMessageLocal(conv, text, item){
    const msg = { id: 'm'+Date.now(), sender: currentUser.name, text, time: Date.now(), item }
    conv.messages.push(msg)
    save(state); renderConversations(); renderMessages()
  }

  // helpers
  function initials(name){ return (name||'')[0] ? name.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase() : '?' }
  function timeAgo(ts){ const d = Date.now()-ts; if(d<60000) return 'just now'; if(d<3600e3) return Math.round(d/60000)+'m'; if(d<86400e3) return Math.round(d/3600e3)+'h'; return new Date(ts).toLocaleDateString() }

  // events
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const text = input.value.trim(); if(!text) return;
    const conv = state.conversations.find(x=>x.id===state.selectedConversationId)
    if(!conv) return alert('Select a conversation')
    try{
      if(isServerConvId(conv.id)){
        await sendMessageToServer(conv, text)
      } else {
        // send to server to create conv on first message
        const res = await sendMessageToServer(conv, text)
        if(!res || !res.success){
          // fallback to local
          sendMessageLocal(conv, text)
        }
      }
      input.value = ''
      input.focus()
    }catch(err){
      console.error(err); // fallback to local store
      sendMessageLocal(conv, text)
    }
  })

  attachBtn.addEventListener('click', ()=>{
    if(!state.selectedConversationId) return alert('Select a conversation first')
    itemModal.classList.remove('hidden'); itemTitle.value=''; itemLink.value=''; itemTitle.focus()
  })

  cancelItem.addEventListener('click', ()=>{ itemModal.classList.add('hidden') })
  attachItem.addEventListener('click', async ()=>{
    const title = itemTitle.value.trim(); const link = itemLink.value.trim();
    if(!title) return alert('Please enter an item title')
    const text = input.value.trim()
    const conv = state.conversations.find(x=>x.id===state.selectedConversationId)
    if(!conv) return
    try{
      if(isServerConvId(conv.id)){
        await sendMessageToServer(conv, text || ('Shared item: '+title), { title, link })
      } else {
        await sendMessageToServer(conv, text || ('Shared item: '+title), { title, link })
      }
    }catch(err){ console.error(err); sendMessageLocal(conv, text || ('Shared item: '+title), { title, link }) }
    itemModal.classList.add('hidden')
  })

  newConvBtn.addEventListener('click', ()=>{
    const name = prompt('Enter user name to start conversation with')
    if(!name) return
    const id = 'local-'+Date.now()
    const conv = { id, name, messages: [] }
    state.conversations.unshift(conv)
    state.selectedConversationId = id
    save(state)
    renderConversations()
    renderMessages()
  })

  // initial render and attempt to load server conversations to merge
  (async function init(){
    try{
      const res = await API.get('/api/getConversations')
      if(res && res.conversations){
        // merge server conversations into local list if not present
        res.conversations.forEach(sc => {
          if(!state.conversations.find(c=>c.id===sc.id)){
            state.conversations.push({ id: sc.id, name: sc.id, messages: [] })
          }
        })
      }
    }catch(err){ console.warn('Could not load server conversations', err) }
    if(!state.selectedConversationId && state.conversations.length) state.selectedConversationId = state.conversations[0].id
    save(state)
    renderConversations()
    renderMessages()
    // if selected conversation is server-side, fetch messages and subscribe
    const sel = state.selectedConversationId
    if(sel && isServerConvId(sel)) selectConversation(sel)
  })()

  // expose for debug
  window._lnf = { state, save }

})()
(function(){
    const STORAGE_KEY = 'lnf_dm_data_v1'
    const currentUser = {id:'me', name:'You'}
  
    const defaultData = {
      conversations: [
        {id:'c1', name:'Alice', messages:[
          {id:'m1', sender:'Alice', text:'Hi — did you find a blue wallet near the library?', time: Date.now()-3600e3}
        ]},
        {id:'c2', name:'Bob', messages:[
          {id:'m2', sender:'Bob', text:'I think I lost keys at the gym. Any leads?', time: Date.now()-7200e3}
        ]}
      ],
      selectedConversationId: null
    }
  
    function load(){
      try{
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) : defaultData
      }catch(e){
        console.error('Failed to load',e)
        return defaultData
      }
    }
  
    function save(state){
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  
    // DOM refs
    const convList = document.getElementById('conversationsList')
    const convTmpl = document.getElementById('convItemTmpl')
    const msgTmpl = document.getElementById('msgTmpl')
    const messagesEl = document.getElementById('messages')
    const chatHeader = document.getElementById('chatHeader')
    const titleEl = chatHeader.querySelector('.chat-title')
    const form = document.getElementById('messageForm')
    const input = document.getElementById('messageInput')
    const attachBtn = document.getElementById('attachItemBtn')
    const newConvBtn = document.getElementById('newConvBtn')
  
    const itemModal = document.getElementById('itemModal')
    const itemTitle = document.getElementById('itemTitle')
    const itemLink = document.getElementById('itemLink')
    const cancelItem = document.getElementById('cancelItem')
    const attachItem = document.getElementById('attachItem')
  
    let state = load()
    if(!state.selectedConversationId && state.conversations.length) state.selectedConversationId = state.conversations[0].id
  
    function renderConversations(){
      convList.innerHTML = ''
      state.conversations.forEach(c=>{
        const li = convTmpl.content.firstElementChild.cloneNode(true)
        li.dataset.id = c.id
        li.querySelector('.avatar').textContent = initials(c.name)
        li.querySelector('.name').textContent = c.name
        const last = c.messages && c.messages.length ? c.messages[c.messages.length-1] : null
        li.querySelector('.snippet').textContent = last ? (last.text.slice(0,60)) : 'No messages yet'
        li.querySelector('.time').textContent = last ? timeAgo(last.time) : ''
        li.addEventListener('click', ()=>{ selectConversation(c.id) })
        if(c.id === state.selectedConversationId) li.classList.add('active')
        convList.appendChild(li)
      })
    }
  
    function renderMessages(){
      const conv = state.conversations.find(x=>x.id === state.selectedConversationId)
      messagesEl.innerHTML = ''
      if(!conv){ titleEl.textContent = 'Select a conversation'; return }
      titleEl.textContent = conv.name
      conv.messages.forEach(m=>{
        const node = msgTmpl.content.firstElementChild.cloneNode(true)
        node.dataset.id = m.id
        node.classList.toggle('me', m.sender === currentUser.name || m.sender === currentUser.id)
        node.querySelector('.avatar').textContent = initials(m.sender)
        node.querySelector('.sender').textContent = m.sender
        node.querySelector('.text').textContent = m.text || ''
        const itemRef = node.querySelector('.item-ref')
        if(m.item){
          const a = document.createElement('a')
          a.textContent = m.item.title
          a.href = m.item.link || '#'
          a.style.color = 'var(--accent)'
          itemRef.appendChild(a)
        } else {
          itemRef.remove()
        }
        node.querySelector('.ts').textContent = new Date(m.time).toLocaleString()
        messagesEl.appendChild(node)
      })
      messagesEl.scrollTop = messagesEl.scrollHeight
    }
  
    function selectConversation(id){
      state.selectedConversationId = id
      save(state)
      renderConversations()
      renderMessages()
    }
  
    function sendMessage(text, item){
      if(!text || !state.selectedConversationId) return
      const conv = state.conversations.find(x=>x.id === state.selectedConversationId)
      const msg = {id:'m'+Date.now(), sender:currentUser.name, text, time:Date.now(), item}
      conv.messages.push(msg)
      save(state)
      renderConversations()
      renderMessages()
      input.value = ''
      input.focus()
    }
  
    // helpers
    function initials(name){
      return (name||'')[0] ? name.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase() : '?'
    }
    function timeAgo(ts){
      const d = Date.now()-ts
      if(d<60000) return 'just now'
      if(d<3600e3) return Math.round(d/60000)+'m'
      if(d<86400e3) return Math.round(d/3600e3)+'h'
      return new Date(ts).toLocaleDateString()
    }
  
    // events
    form.addEventListener('submit', e=>{
      e.preventDefault()
      const text = input.value.trim()
      sendMessage(text)
    })
  
    attachBtn.addEventListener('click', ()=>{
      if(!state.selectedConversationId) return alert('Select a conversation first')
      itemModal.classList.remove('hidden')
      itemTitle.value = ''
      itemLink.value = ''
      itemTitle.focus()
    })
  
    cancelItem.addEventListener('click', ()=>{ itemModal.classList.add('hidden') })
    attachItem.addEventListener('click', ()=>{
      const title = itemTitle.value.trim()
      const link = itemLink.value.trim()
      if(!title) return alert('Please enter an item title')
      const text = input.value.trim()
      sendMessage(text || ('Shared item: '+title), {title, link})
      itemModal.classList.add('hidden')
    })
  
    newConvBtn.addEventListener('click', ()=>{
      const name = prompt('Enter user name to start conversation with')
      if(!name) return
      const id = 'c'+Date.now()
      state.conversations.unshift({id, name, messages:[]})
      selectConversation(id)
      save(state)
    })
  
    // initial render
    renderConversations()
    renderMessages()
  
    // expose for debug
    window._lnf = {state, save}
  
  })()