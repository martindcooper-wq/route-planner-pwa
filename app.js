// ---------- storage ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};
const KEYS = { SITES:"rp_sites", ROUTES:"rp_routes", LEG:"rp_leg_cache" };
const uuid = () => (crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2)));

let sites = store.get(KEYS.SITES, []);
let routes = store.get(KEYS.ROUTES, []);
let legCache = store.get(KEYS.LEG, {}); // key: "lon,lat|lon,lat" -> {meters, seconds, ts}

let current = { id: uuid(), title:"", stopIds:[], start:{ mode:"current", manual:"" } };

// ---------- helpers ----------
const el = (id) => document.getElementById(id);
const setStatus = (m) => el("status").textContent = m;
const metersToMiles = (m) => m / 1609.344;

function haversineMeters(a,b){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const x=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function keyFor(a,b){ return `${a.lon.toFixed(6)},${a.lat.toFixed(6)}|${b.lon.toFixed(6)},${b.lat.toFixed(6)}`; }
function getSite(id){ return sites.find(s => s.id === id); }

// ---------- UI wiring ----------
function updateStartUI(){
  const mode = el("startMode").value;
  el("manualWrap").style.display = mode === "manual" ? "block" : "none";
  current.start.mode = mode;
}
el("startMode").addEventListener("change", updateStartUI);

el("addSiteBtn").addEventListener("click", () => {
  const name = el("siteName").value.trim();
  const address = el("siteAddr").value.trim();
  const lat = el("siteLat").value.trim();
  const lon = el("siteLon").value.trim();
  const notes = el("siteNotes").value.trim();

  if (!name || !address) return alert("Please enter name + address/postcode.");

  sites.unshift({
    id: uuid(),
    name, address,
    lat: lat ? Number(lat) : null,
    lon: lon ? Number(lon) : null,
    notes,
    createdAt: Date.now()
  });
  store.set(KEYS.SITES, sites);

  el("siteName").value = ""; el("siteAddr").value = ""; el("siteLat").value = ""; el("siteLon").value = ""; el("siteNotes").value = "";
  renderSites(); renderStops();
  setStatus("Site saved.");
});

el("clearAllBtn").addEventListener("click", () => {
  if (!confirm("This deletes ALL sites, routes, and cached mileage. Continue?")) return;
  sites = []; routes = []; legCache = {};
  store.set(KEYS.SITES, sites); store.set(KEYS.ROUTES, routes); store.set(KEYS.LEG, legCache);
  current = { id: uuid(), title:"", stopIds:[], start:{ mode:"current", manual:"" } };
  el("routeTitle").value = ""; el("manualStart").value = "";
  renderSites(); renderStops(); renderRoutes(); renderMileage([]);
  setStatus("Cleared.");
});

el("newRouteBtn").addEventListener("click", () => {
  current = { id: uuid(), title:"", stopIds:[], start:{ mode: el("startMode").value, manual:"" } };
  el("routeTitle").value = ""; el("manualStart").value = "";
  renderSites(); renderStops(); renderMileage([]);
  setStatus("New route.");
});

el("saveRouteBtn").addEventListener("click", () => {
  const title = el("routeTitle").value.trim() || `Route ${new Date().toLocaleDateString()}`;
  current.title = title;
  current.start.mode = el("startMode").value;
  current.start.manual = el("manualStart").value.trim();

  if (!current.stopIds.length) return alert("Select at least 1 stop.");
  routes = routes.filter(r => r.id !== current.id);
  routes.unshift(structuredClone(current));
  store.set(KEYS.ROUTES, routes);
  renderRoutes();
  setStatus("Route saved.");
});

el("calcBtn").addEventListener("click", async () => {
  await calculateAndCache();
});

el("loadBtn").addEventListener("click", () => {
  const legs = loadCachedLegs();
  renderMileage(legs);
  setStatus("Loaded cached/offline estimate.");
});

el("navGoogleBtn").addEventListener("click", () => navigate("google"));
el("navWazeBtn").addEventListener("click", () => navigate("waze"));

// ---------- rendering ----------
function renderSites(){
  const list = el("sitesList");
  list.innerHTML = "";
  if (!sites.length) {
    list.innerHTML = `<div class="muted">No sites yet. Add one above.</div>`;
    return;
  }
  for (const s of sites){
    const selected = current.stopIds.includes(s.id);
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <h3>${s.name}${selected ? `<span class="pill">Selected</span>` : ""}</h3>
      <div class="muted">${s.address}</div>
      <div class="muted">${(s.lat!=null && s.lon!=null) ? `📍 ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : `📍 coords missing (ok)`}</div>
    `;
    div.addEventListener("click", () => {
      if (selected) current.stopIds = current.stopIds.filter(x => x !== s.id);
      else current.stopIds.push(s.id);
      renderSites(); renderStops();
    });
    list.appendChild(div);
  }
}

function renderStops(){
  const list = el("routeStops");
  list.innerHTML = "";
  const stops = current.stopIds.map(getSite).filter(Boolean);

  if (!stops.length){
    list.innerHTML = `<div class="muted">Select sites above to build a route.</div>`;
    return;
  }
  stops.forEach((s, idx) => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <h3>${idx+1}. ${s.name}</h3>
      <div class="muted">${s.address}</div>
      <div class="split" style="margin-top:8px;">
        <button class="secondary" data-act="up" ${idx===0?"disabled":""}>↑</button>
        <button class="secondary" data-act="down" ${idx===stops.length-1?"disabled":""}>↓</button>
      </div>
    `;
    div.querySelector('[data-act="up"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (idx === 0) return;
      const ids = [...current.stopIds];
      [ids[idx-1], ids[idx]] = [ids[idx], ids[idx-1]];
      current.stopIds = ids;
      renderSites(); renderStops();
    });
    div.querySelector('[data-act="down"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (idx === stops.length-1) return;
      const ids = [...current.stopIds];
      [ids[idx], ids[idx+1]] = [ids[idx+1], ids[idx]];
      current.stopIds = ids;
      renderSites(); renderStops();
    });
    list.appendChild(div);
  });
}

function renderRoutes(){
  const list = el("savedRoutes");
  list.innerHTML = "";
  if (!routes.length){
    list.innerHTML = `<div class="muted">No saved routes yet.</div>`;
    return;
  }
  for (const r of routes){
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <h3>${r.title || "Untitled"}</h3>
      <div class="muted">${r.stopIds?.length ?? 0} stops • Start: ${r.start?.mode ?? "current"}</div>
      <div class="split" style="margin-top:8px;">
        <button class="secondary" data-act="load">Load</button>
        <button class="danger" data-act="del">Delete</button>
      </div>
    `;
    div.querySelector('[data-act="load"]').addEventListener("click", () => {
      current = structuredClone(r);
      el("routeTitle").value = current.title || "";
      el("startMode").value = current.start?.mode || "current";
      el("manualStart").value = current.start?.manual || "";
      updateStartUI();
      renderSites(); renderStops();
      const legs = loadCachedLegs();
      renderMileage(legs);
      setStatus("Route loaded.");
    });
    div.querySelector('[data-act="del"]').addEventListener("click", () => {
      routes = routes.filter(x => x.id !== r.id);
      store.set(KEYS.ROUTES, routes);
      renderRoutes();
    });
    list.appendChild(div);
  }
}

function renderMileage(legs){
  const total = legs.reduce((sum, l) => sum + l.miles, 0);
  el("totalMiles").textContent = total.toFixed(1);
  el("legs").innerHTML = legs.map(l =>
    `<div class="leg"><strong>${l.from} → ${l.to}</strong><div class="muted">${l.miles.toFixed(1)} mi • ${l.minutes.toFixed(0)} min${l.note ? ` (${l.note})` : ""}</div></div>`
  ).join("") || `<div class="muted">No mileage yet. Tap “Calculate & Cache”.</div>`;
}

// ---------- online helpers (geocode + routing) ----------
async function geocodeNominatim(query){
  // light use only
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept":"application/json" } });
  if (!res.ok) throw new Error("Geocode failed");
  const data = await res.json();
  if (!data?.length) throw new Error("No geocode result");
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

async function osrmDriving(a,b){
  // public demo router
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Route failed");
  const json = await res.json();
  const route = json?.routes?.[0];
  if (!route) throw new Error("No route");
  return { meters: route.distance, seconds: route.duration };
}

async function resolveStartPoint(){
  const mode = el("startMode").value;
  if (mode === "current"){
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:12000 })
    );
    return { lat: pos.coords.latitude, lon: pos.coords.longitude, name:"Start" };
  }
  const manual = el("manualStart").value.trim();
  if (!manual) throw new Error("Enter a manual start postcode/address.");
  const pt = await geocodeNominatim(manual);
  return { ...pt, name:"Start" };
}

async function resolveSitePoint(site){
  if (site.lat!=null && site.lon!=null) return { lat: site.lat, lon: site.lon };
  const pt = await geocodeNominatim(site.address);
  site.lat = pt.lat; site.lon = pt.lon;
  store.set(KEYS.SITES, sites);
  return pt;
}

// ---------- calculate + cache ----------
async function calculateAndCache(){
  const stops = current.stopIds.map(getSite).filter(Boolean);
  if (!stops.length) return alert("Select at least 1 stop.");

  setStatus("Resolving start point…");
  let start;
  try { start = await resolveStartPoint(); }
  catch(e){ setStatus(`Start error: ${e.message || e}`); return; }

  setStatus("Resolving stops & calculating legs…");
  const points = [{ name:"Start", point:{lat:start.lat, lon:start.lon} }];

  for (const s of stops){
    try {
      const p = await resolveSitePoint(s);
      points.push({ name: s.name, point: p });
    } catch {
      points.push({ name: s.name, point: null });
    }
  }

  const legs = [];
  for (let i=0;i<points.length-1;i++){
    const A=points[i], B=points[i+1];
    let meters=0, seconds=0, note="cached/approx";

    if (A.point && B.point){
      const k = keyFor(A.point, B.point);
      try {
        const r = await osrmDriving(A.point, B.point);
        meters = r.meters; seconds = r.seconds;
        legCache[k] = { meters, seconds, ts: Date.now() };
        note = "live";
      } catch {
        if (legCache[k]) { meters = legCache[k].meters; seconds = legCache[k].seconds; note="cached"; }
        else { meters = haversineMeters(A.point, B.point); seconds = (metersToMiles(meters)/30)*3600; note="approx"; }
      }
    }

    legs.push({
      from: A.name,
      to: B.name,
      miles: metersToMiles(meters),
      minutes: seconds/60,
      note
    });
  }

  store.set(KEYS.LEG, legCache);
  renderMileage(legs);
  setStatus("Done. Cached for offline use.");
}

function loadCachedLegs(){
  const stops = current.stopIds.map(getSite).filter(Boolean);
  if (stops.length < 2) return [];

  const pts = stops.map(s => (s.lat!=null && s.lon!=null) ? {name:s.name, point:{lat:s.lat, lon:s.lon}} : {name:s.name, point:null});

  const legs = [];
  for (let i=0;i<pts.length-1;i++){
    const A=pts[i], B=pts[i+1];
    let meters=0, seconds=0, note="offline approx";
    if (A.point && B.point){
      const k = keyFor(A.point, B.point);
      if (legCache[k]) { meters=legCache[k].meters; seconds=legCache[k].seconds; note="cached"; }
      else { meters=haversineMeters(A.point, B.point); seconds=(metersToMiles(meters)/30)*3600; note="approx"; }
    }
    legs.push({ from:A.name, to:B.name, miles:metersToMiles(meters), minutes:seconds/60, note });
  }
  return legs;
}

// ---------- navigation ----------
function navigate(which){
  const first = current.stopIds.map(getSite).find(Boolean);
  if (!first) return alert("No route loaded.");
  if (first.lat==null || first.lon==null) return alert("This stop has no coordinates yet. Tap Calculate once (online) to save them.");

  const dest = encodeURIComponent(`${first.lat},${first.lon}`);
  const url = (which === "google")
    ? `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`
    : `https://waze.com/ul?ll=${dest}&navigate=yes`;

  window.location.href = url;
}

// ---------- init ----------
updateStartUI();
renderSites();
renderStops();
renderRoutes();
renderMileage([]);
setStatus("Ready.");
