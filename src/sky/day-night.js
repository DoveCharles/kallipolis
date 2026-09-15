import { S, App } from '../core/shared.js';
import { updateSun } from '../core/scene.js';

// ============================================================ day / night cycle
// With the cycle on, the clock runs — a whole day in dayLengthMinutes — and the sun follows the path it really takes over a
// mid-latitude city in late spring: rising in the east, arcing through the south to peak at 57°, and setting in the west,
// with world north along -Z and east along +X. (At night updateSun hands the light over to the moon.) The light moves
// every frame; the sky reflection, window glow and the World panel's sliders follow a couple of times a second.
const DAY_LATITUDE = 45, DAY_DECLINATION = 12; // degrees
S.dayNightEnabled = false, S.dayLengthMinutes = 4, S.timeOfDay = 9; // hours
let lastDayNightTime = null, lastFullSunUpdate = -Infinity;
// the sun's elevation and azimuth, in updateSun's terms (degrees; azimuth measured from +Z towards +X), at a time of day
function sunPositionAt(hours) {
  const rad = Math.PI/180, lat = DAY_LATITUDE*rad, dec = DAY_DECLINATION*rad, hourAngle = (hours - 12)*15*rad;
  const elevation = Math.asin(Math.sin(lat)*Math.sin(dec) + Math.cos(lat)*Math.cos(dec)*Math.cos(hourAngle));
  // the classic formula gives azimuth from south, positive towards the west; turned to clockwise from north, then to +Z-based
  const fromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle)*Math.sin(lat) - Math.tan(dec)*Math.cos(lat));
  const fromNorth = fromSouth + Math.PI;
  return { elevation: elevation/rad, azimuth: (((180 - fromNorth/rad) % 360) + 360) % 360 };
}
function applyTimeOfDay(quick) {
  const { elevation, azimuth } = sunPositionAt(S.timeOfDay);
  S.sunElevation = elevation;
  S.sunAzimuth = azimuth;
  updateSun(quick);
  if (!quick) syncSkyUI();
}
export function updateDayNight(t) {
  const dt = lastDayNightTime == null ? 0 : Math.min(0.25, Math.max(0, t - lastDayNightTime));
  lastDayNightTime = t;
  if (!S.dayNightEnabled) return;
  S.timeOfDay = (S.timeOfDay + dt*24/(S.dayLengthMinutes*60)) % 24;
  const full = t - lastFullSunUpdate > 0.5;
  if (full) lastFullSunUpdate = t;
  applyTimeOfDay(!full);
}
export function syncSkyUI() {
  const hours = Math.floor(S.timeOfDay), minutes = Math.floor((S.timeOfDay - hours)*60);
  document.getElementById('s-daynight').classList.toggle('on', S.dayNightEnabled);
  document.getElementById('daynight-settings').style.display = S.dayNightEnabled ? 'block' : 'none';
  document.getElementById('s-timeofday').value = S.timeOfDay;
  document.getElementById('dv-timeofday').textContent = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  document.getElementById('s-daylength').value = S.dayLengthMinutes;
  document.getElementById('dv-daylength').textContent = S.dayLengthMinutes;
  // the sun sliders follow the clock, and can't be dragged while it runs
  [['s-sunelev', 'dv-sunelev', S.sunElevation], ['s-sunazim', 'dv-sunazim', S.sunAzimuth]].forEach(([sliderId, valueId, value]) => {
    const slider = document.getElementById(sliderId);
    slider.value = Math.round(value);
    slider.disabled = S.dayNightEnabled;
    document.getElementById(valueId).textContent = Math.round(value);
  });
  [['rain', S.weatherRain], ['snow', S.weatherSnow], ['clouds', S.weatherClouds]].forEach(([kind, value]) => {
    document.getElementById('s-' + kind).value = value;
    document.getElementById('dv-' + kind).textContent = value.toFixed(2);
  });
}

Object.assign(App, { applyTimeOfDay, syncSkyUI });
