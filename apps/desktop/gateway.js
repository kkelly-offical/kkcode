document.getElementById('gateway').addEventListener('submit', async event => {
  event.preventDefault()
  const button = document.getElementById('connect'), error = document.getElementById('error')
  button.disabled = true; error.textContent = ''
  try { await window.kkcodeGateway.connect(document.getElementById('origin').value) }
  catch (cause) { error.textContent = cause.message; button.disabled = false }
})
