// Where the page gets its data. "server": the Python service that serves this page (docker compose, uvicorn).
// tools/build_pages.py replaces this file for GitHub Pages with backend: "browser" (see local/backend.js).
window.SKYHOP_RUNTIME = { backend: "server" };
