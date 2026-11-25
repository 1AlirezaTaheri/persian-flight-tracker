"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const formatNumber = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
  const formatTime = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const number = (value, unit) => Number.isFinite(value)
    ? `${formatNumber.format(value)} ${unit}` : "نامشخص";
  const banner = (message, tone = "warning") => {
    $("banner").textContent = message;
    $("banner").dataset.tone = tone;
    $("banner").hidden = !message;
  };
  if (!window.L) {
    banner("خطا در بارگذاری نقشه؛ اتصال اینترنت را بررسی و صفحه را دوباره بارگذاری کنید.", "error");
    $("connection-text").textContent = "نقشه در دسترس نیست";
    $("status-dot").dataset.state = "error";
    return;
  }

  // Resolve upstream English country names to Persian without another API.
  const countries = new Map();
  if (typeof Intl.DisplayNames === "function") {
    const english = new Intl.DisplayNames(["en"], { type: "region" });
    const persian = new Intl.DisplayNames(["fa"], { type: "region" });
    const codes = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";
    for (const code of codes.split(" ")) {
      countries.set(english.of(code).toLowerCase(), persian.of(code));
      countries.set(code.toLowerCase(), persian.of(code));
    }
  }
  const aliases = {
    "iran": "IR", "iran (islamic republic of)": "IR", "islamic republic of iran": "IR",
    "united states": "US", "united states of america": "US", "russian federation": "RU",
    "republic of korea": "KR", "korea, republic of": "KR", "democratic people's republic of korea": "KP",
    "syrian arab republic": "SY", "lao people's democratic republic": "LA", "viet nam": "VN",
    "republic of moldova": "MD", "moldova, republic of": "MD", "bolivia": "BO", "venezuela": "VE",
    "united republic of tanzania": "TZ", "brunei darussalam": "BN", "czech republic": "CZ",
    "swaziland": "SZ", "macedonia, the former yugoslav republic of": "MK", "turkey": "TR",
    "cape verde": "CV", "the netherlands": "NL", "taiwan": "TW", "palestine": "PS"
  };
  function countryName(name) {
    const key = String(name || "").trim().toLowerCase();
    return countries.get(key) || countries.get((aliases[key] || "").toLowerCase()) || "نام کشور در دسترس نیست";
  }

  const map = L.map("map", { zoomControl: false, minZoom: 2, maxBounds: [[-85, -180], [85, 180]] })
    .setView([32.4, 53.7], 5);
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: "topleft", zoomInTitle: "بزرگ‌نمایی", zoomOutTitle: "کوچک‌نمایی" }).addTo(map);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, noWrap: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">مشارکت‌کنندگان اُپن‌استریت‌مپ</a>'
  }).addTo(map);

  const markers = new Map();
  let flights = new Map();
  let selectedId = null;
  let snapshot = null;
  let networkError = false;
  let tileError = false;
  const textNode = (text) => { const span = document.createElement("span"); span.textContent = text; return span; };
  const normalizeQuery = (value) => value.trim().toUpperCase().replace(/\s/g, "")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));

  function planeIcon() {
    const glyph = document.createElement("span");
    glyph.className = "aircraft-glyph";
    glyph.setAttribute("aria-hidden", "true");
    // The SVG points north; rotate its child, never Leaflet's positioned element.
    glyph.innerHTML = '<svg viewBox="0 0 32 32"><path d="M16 2c-1.2 0-2 1.5-2 3v7L3 20v3l11-4v7l-4 3v2l6-2 6 2v-2l-4-3v-7l11 4v-3l-11-8V5c0-1.5-.8-3-2-3Z"/></svg>';
    return L.divIcon({ className: "aircraft-marker", html: glyph, iconSize: [34, 34], iconAnchor: [17, 17] });
  }

  function renderDetails() {
    const flight = flights.get(selectedId);
    if (!flight) return;
    $("detail-callsign").textContent = flight.callsign || "پرواز بی‌نام";
    $("detail-country").textContent = countryName(flight.origin_country);
    $("detail-altitude").textContent = number(flight.altitude, "متر");
    $("detail-speed").textContent = number(Number.isFinite(flight.velocity) ? flight.velocity * 3.6 : null, "کیلومتر بر ساعت");
    $("detail-heading").textContent = number(flight.true_track, "درجه");
    $("detail-icao").textContent = flight.icao24.toUpperCase();
    $("detail-status").textContent = flight.on_ground ? "روی زمین" : "در حال پرواز";
    $("placeholder").hidden = true;
    $("details").hidden = false;
    $("sidebar").classList.add("is-open");
  }

  function closeDetails() {
    selectedId = null;
    $("details").hidden = true;
    $("placeholder").hidden = false;
    $("sidebar").classList.remove("is-open");
    renderMap();
  }

  function renderMap() {
    const query = normalizeQuery($("search").value);
    const airborne = $("airborne-only").checked;
    const bounds = map.getBounds();
    const visible = new Set();
    for (const [id, flight] of flights) {
      if (!normalizeQuery(flight.callsign).includes(query) || (airborne && flight.on_ground)) continue;
      if (!bounds.contains([flight.latitude, flight.longitude])) continue;
      visible.add(id);
      let marker = markers.get(id);
      if (!marker) {
        marker = L.marker([flight.latitude, flight.longitude], {
          icon: planeIcon(), title: flight.callsign || "پرواز بی‌نام", keyboard: true,
          alt: "نمایش جزئیات پرواز", riseOnHover: true
        }).addTo(map);
        marker.bindTooltip(textNode(flight.callsign || "پرواز بی‌نام"), { direction: "top", offset: [0, -12] });
        marker.on("click", () => { selectedId = id; renderDetails(); renderMap(); });
        markers.set(id, marker);
      }
      marker.setLatLng([flight.latitude, flight.longitude]);
      marker.setTooltipContent(textNode(flight.callsign || "پرواز بی‌نام"));
      marker.setZIndexOffset(id === selectedId ? 1000 : 0);
      const element = marker.getElement();
      element.classList.toggle("is-selected", id === selectedId);
      element.classList.toggle("is-ground", flight.on_ground);
      element.setAttribute("title", flight.callsign || "پرواز بی‌نام");
      element.setAttribute("aria-label", `نمایش جزئیات پرواز ${flight.callsign || "بی‌نام"}`);
      element.querySelector(".aircraft-glyph").style.setProperty("--heading", `${flight.true_track ?? 0}deg`);
    }
    for (const [id, marker] of markers) {
      if (!visible.has(id)) { marker.remove(); markers.delete(id); }
    }
    $("visible-count").textContent = formatNumber.format(visible.size);
    $("total-count").textContent = snapshot?.updated_at
      ? `${formatNumber.format(flights.size)} هواپیما در کل داده‌ها` : "در انتظار داده‌های زنده";
    $("empty-state").hidden = !snapshot?.updated_at || visible.size > 0;
  }

  function updateStatus() {
    const now = Date.now() / 1000;
    const timestamp = snapshot?.source_time || snapshot?.updated_at;
    $("last-update").textContent = `آخرین به‌روزرسانی: ${timestamp ? formatTime.format(new Date(timestamp * 1000)) : "—"}`;
    const failed = networkError || Boolean(snapshot?.error);
    const stale = Boolean(snapshot?.stale) || (timestamp && now - timestamp > 45);
    $("status-dot").dataset.state = failed ? "error" : !timestamp ? "loading" : stale ? "stale" : "live";
    $("connection-text").textContent = failed ? "اختلال در دریافت" : !timestamp ? "در حال اتصال" : stale ? "دادهٔ قدیمی" : "دریافت زنده";
    if (failed) {
      let message = "خطا در دریافت داده";
      message += timestamp ? "؛ آخرین اطلاعات ذخیره‌شده نمایش داده می‌شود." : "؛ اتصال به سرویس برقرار نشد.";
      const wait = Math.ceil((snapshot?.next_fetch_at || 0) - now);
      if (!networkError && wait > 12) message += ` تلاش بعدی تا ${formatNumber.format(wait)} ثانیهٔ دیگر.`;
      banner(message, "error");
    } else if (!timestamp) {
      banner("در حال دریافت اطلاعات پروازها…");
    } else if (stale) {
      banner("داده‌ها قدیمی هستند؛ در انتظار اطلاعات تازه از سرویس.");
    } else if (tileError) {
      banner("خطا در بارگذاری بخشی از نقشه؛ اتصال اینترنت را بررسی کنید.", "error");
    } else {
      banner("");
    }
  }

  async function poll() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("/api/aircraft", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Backend unavailable");
      const data = await response.json();
      if (!Array.isArray(data.aircraft)) throw new Error("Invalid snapshot");
      snapshot = data;
      networkError = false;
      flights = new Map(data.aircraft.filter((flight) => typeof flight.icao24 === "string"
        && typeof flight.callsign === "string" && Number.isFinite(flight.latitude)
        && Number.isFinite(flight.longitude)).map((flight) => [flight.icao24, flight]));
      if (selectedId && !flights.has(selectedId)) {
        $("selection-hint").textContent = "پرواز انتخاب‌شده دیگر در آخرین داده‌ها وجود ندارد.";
        closeDetails();
      }
      renderMap();
      renderDetails();
    } catch (_error) {
      // Keep current markers and selection during network/server failures.
      networkError = true;
    } finally {
      clearTimeout(timeout);
      updateStatus();
      setTimeout(poll, 12000); // Recursive scheduling prevents overlapping requests.
    }
  }

  map.on("moveend", renderMap);
  tiles.on("loading", () => { tileError = false; updateStatus(); });
  tiles.on("tileerror", () => { tileError = true; updateStatus(); });
  $("search").addEventListener("input", renderMap);
  $("airborne-only").addEventListener("change", renderMap);
  $("close-details").addEventListener("click", closeDetails);
  $("home-view").addEventListener("click", () => map.setView([32.4, 53.7], 5));
  $("locate-flight").addEventListener("click", () => {
    const flight = flights.get(selectedId);
    if (flight) map.setView([flight.latitude, flight.longitude], Math.max(map.getZoom(), 7));
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDetails(); });
  setInterval(updateStatus, 1000);
  poll();
})();
