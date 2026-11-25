"""A single-process, anonymous OpenSky proxy with a shared background cache."""

import atexit
import logging
import math
import re
import threading
import time
from email.utils import parsedate_to_datetime

import requests
from flask import Flask, jsonify, render_template

OPENSKY_URL = "https://opensky-network.org/api/states/all"
REFRESH_SECONDS = 12
ERROR_MESSAGE = "خطا در دریافت داده"
logger = logging.getLogger(__name__)


def number(value):
    """Reject NaN, infinity and booleans before serializing upstream data."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if math.isfinite(value) else None
    return None


def normalize_states(states):
    aircraft = {}
    for row in states:
        if not isinstance(row, list) or len(row) < 11:
            continue
        icao24 = str(row[0] or "").strip().lower()
        lon, lat = number(row[5]), number(row[6])
        if not re.fullmatch(r"[0-9a-f]{6}", icao24):
            continue
        if lon is None or lat is None or not (-180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        heading, speed = number(row[10]), number(row[9])
        aircraft[icao24] = {
            "icao24": icao24,
            "callsign": str(row[1] or "").strip()[:32],
            "origin_country": str(row[2] or "").strip()[:100],
            "longitude": lon,
            "latitude": lat,
            "altitude": number(row[7]),
            "velocity": speed if speed is not None and speed >= 0 else None,
            "true_track": heading % 360 if heading is not None else None,
            "on_ground": row[8] is True,
        }
    return list(aircraft.values())


def retry_delay(headers, fallback):
    """Honor both OpenSky's header and standard Retry-After seconds/HTTP dates."""
    delays = [fallback]
    for name in ("X-Rate-Limit-Retry-After-Seconds", "Retry-After"):
        raw = headers.get(name)
        if raw is None:
            continue
        try:
            delay = float(raw)
        except (ValueError, TypeError):
            try:
                delay = parsedate_to_datetime(raw).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError):
                continue
        if math.isfinite(delay) and delay >= 0:
            delays.append(delay)
    # A supplied retry hint replaces the fallback, but never the 12-second floor.
    return max(REFRESH_SECONDS, max(delays[1:])) if len(delays) > 1 else fallback


class AircraftCache:
    def __init__(self, session=None):
        self.session = session or requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "User-Agent": "PersianFlightTracker/1.0",
        })
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.aircraft = []
        self.updated_at = None
        self.source_time = None
        self.error = None
        self.next_fetch_at = None
        self.rate_limit_remaining = None
        self.failures = 0

    def start(self):
        with self.lock:
            if self.thread is not None:
                return
            self.thread = threading.Thread(target=self._run, name="opensky-fetcher", daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=12)

    def _run(self):
        while not self.stop_event.is_set():
            self.stop_event.wait(self.fetch_once())
        self.session.close()

    def fetch_once(self):
        """Only the worker calls this method; HTTP handlers never fetch upstream."""
        started = time.monotonic()
        response = None
        try:
            response = self.session.get(OPENSKY_URL, timeout=(3.05, 8))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or "states" not in payload:
                raise ValueError("Unexpected OpenSky response")
            states = payload["states"]
            if states is not None and not isinstance(states, list):
                raise ValueError("Unexpected state vectors")
            source_time = number(payload.get("time"))
            if source_time is None or source_time <= 0 or source_time > time.time() + 60:
                raise ValueError("Invalid source timestamp")
            aircraft = normalize_states(states or [])
            remaining = response.headers.get("X-Rate-Limit-Remaining", "")
            remaining = int(remaining) if str(remaining).isdigit() else None
            delay = max(0.25, REFRESH_SECONDS - (time.monotonic() - started))
            if remaining == 0:
                # No reset hint: conservatively wait a full daily quota period.
                delay = retry_delay(response.headers, 86400)
            with self.lock:
                self.aircraft = aircraft
                self.updated_at = time.time()
                self.source_time = source_time
                self.rate_limit_remaining = remaining
                self.error = ERROR_MESSAGE if remaining == 0 else None
                self.failures = 0
                self.next_fetch_at = time.time() + delay
            return delay
        except (requests.RequestException, ValueError, TypeError) as exc:
            self.failures += 1
            delay = min(300, REFRESH_SECONDS * 2 ** min(self.failures - 1, 5))
            if response is not None:
                if response.status_code == 429:
                    delay = 86400
                elif response.status_code in (401, 403):
                    delay = max(delay, 300)
                delay = retry_delay(response.headers, delay)
            with self.lock:
                # Preserve the last successful snapshot, including its timestamps.
                self.error = ERROR_MESSAGE
                self.next_fetch_at = time.time() + delay
                if response is not None and response.status_code == 429:
                    self.rate_limit_remaining = 0
            logger.warning("OpenSky fetch failed; retry in %.1fs: %s", delay, exc)
            return delay
        finally:
            if response is not None:
                response.close()

    def snapshot(self):
        with self.lock:
            return {
                "aircraft": self.aircraft,
                "updated_at": self.updated_at,
                "source_time": self.source_time,
                "stale": self.source_time is None or time.time() - self.source_time > 45
                         or self.error is not None,
                "error": self.error,
                "next_fetch_at": self.next_fetch_at,
                "refresh_interval": REFRESH_SECONDS,
                "rate_limit_remaining": self.rate_limit_remaining,
            }


def create_app(start_fetcher=True, cache=None):
    app = Flask(__name__)
    app.json.ensure_ascii = False
    cache = cache if cache is not None else AircraftCache()
    app.extensions["aircraft_cache"] = cache

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/aircraft")
    def get_aircraft():
        response = jsonify(cache.snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(404)
    def not_found(_error):
        return jsonify(error="صفحه پیدا نشد"), 404

    @app.errorhandler(500)
    def internal_error(_error):
        return jsonify(error="خطای داخلی سرور"), 500

    if start_fetcher:
        cache.start()
        atexit.register(cache.stop)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    application = create_app()
    try:
        # Disable the reloader so only one upstream polling thread is started.
        application.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False, threaded=True)
    finally:
        application.extensions["aircraft_cache"].stop()
