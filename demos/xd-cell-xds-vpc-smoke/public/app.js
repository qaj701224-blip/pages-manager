const output = document.querySelector('#output');

document.querySelector('#health').addEventListener('click', () => loadJson('/api/health'));
document.querySelector('#search').addEventListener('click', () => loadJson('/api/xds-search'));

async function loadJson(path) {
  output.textContent = 'Loading...';
  try {
    const response = await fetch(path, { headers: { accept: 'application/json' } });
    const body = await response.json();
    output.textContent = JSON.stringify({ status: response.status, body }, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({ error: String(error?.message || error) }, null, 2);
  }
}
