# Platform connector API reference

The NaLog Agent reads farm/field/sensor data through a REST connector
(`src/integrations/nalog.js`). To connect your own platform, implement these
endpoints or replace `nalog.js` with your own client that returns the same shapes.

All endpoints return JSON. Successful responses wrap data in `{ data: ... }`.
Authentication is via Bearer token in the `Authorization` header.

---

## Endpoints

### `GET /api/farms`

List all farms for the authenticated user.

**Response:**

```json
{
  "data": [
    {
      "farmId": "farm-kutchum",
      "name": "Kut Chum Family Farm",
      "status": "active",
      "description": "32 rai family rice & sugarcane farm",
      "location": { "lat": 16.2719, "lng": 104.3853 }
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `farmId` | string | **yes** | Unique identifier |
| `name` | string | **yes** | Display name |
| `status` | string | no | e.g. `active`, `inactive` |
| `description` | string | no | Human-readable description |
| `location` | `{lat, lng}` | no | GPS coordinates |

---

### `GET /api/farms/:farmId/paddies`

List all fields/paddies for a farm.

**Response:**

```json
{
  "data": [
    {
      "paddyId": "paddy-rice-3",
      "farmId": "farm-kutchum",
      "name": "Paddy 3 (North Rice)",
      "cropType": "rice",
      "cropStatus": "growing",
      "growthStage": "vegetative",
      "area": 4,
      "plantingDate": "2026-05-20",
      "expectedHarvestDate": "2026-10-15",
      "riceConfig": {
        "awdEnabled": true,
        "awdCycleId": "awd-paddy3",
        "targetWaterDepth": 5,
        "drainageDepth": 15,
        "pumpControlEnabled": true,
        "pumpDevEUI": "a84041000181bcd1"
      }
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `paddyId` | string | **yes** | Unique field identifier |
| `farmId` | string | **yes** | Parent farm |
| `name` | string | **yes** | Display name |
| `cropType` | string | **yes** | e.g. `rice`, `sugarcane`, `grape`, `maize` |
| `cropStatus` | string | no | e.g. `growing`, `harvested`, `fallow` |
| `growthStage` | string | no | e.g. `vegetative`, `flowering`, `grand_growth` |
| `area` | number | no | Field area (unit is up to you) |
| `plantingDate` | ISO date | no | Used by crop calendar |
| `expectedHarvestDate` | ISO date | no | |
| `riceConfig` | object | no | Rice-specific (AWD thresholds, pump device) |
| `sugarcaneConfig` | object | no | Sugarcane-specific |

**Your own `cropConfig`:** If your crop isn't rice or sugarcane, you can add your
own config object (e.g. `grapeConfig`, `maizeConfig`). The agent's prompt and
crop calendar need to know how to use it — see `src/agent/prompts.js` and
`src/integrations/cropCalendar.js`.

---

### `GET /api/paddies/:paddyId`

Single paddy by ID. Same shape as above, or `null` / 404 if not found.

---

### `GET /api/farms/:farmId/sensors`

List sensors deployed in a farm.

**Response:**

```json
{
  "data": [
    {
      "sensorId": "sensor-awd-p3",
      "farmId": "farm-kutchum",
      "paddyId": "paddy-rice-3",
      "name": "AWD Tube — Paddy 3",
      "type": "awd",
      "devEUI": "a84041000181aa01",
      "active": true,
      "battery": 87,
      "location": { "lat": 16.272, "lng": 104.3855 }
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `sensorId` | string | **yes** | Unique sensor identifier |
| `farmId` | string | **yes** | |
| `paddyId` | string | **yes** | Which field this sensor is in |
| `name` | string | no | Display name |
| `type` | string | **yes** | e.g. `awd`, `soil_moisture`, `temperature`, `weather` |
| `devEUI` | string | no | LoRaWAN device EUI (for actuation) |
| `active` | boolean | no | |
| `battery` | number | no | Battery level (%) |
| `location` | `{lat, lng}` | no | |

---

### `GET /api/sensors/:sensorId/data?limit=500`

Sensor reading history. The agent requests up to 500 points and filters by time
client-side.

**Response:**

```json
{
  "data": [
    {
      "dataId": "sensor-awd-p3-1721200000000",
      "sensorId": "sensor-awd-p3",
      "timestamp": "2026-07-17T10:00:00.000Z",
      "payload": {
        "level": -12.3,
        "unit": "cm",
        "battery": 87
      }
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `dataId` | string | no | Unique reading ID |
| `sensorId` | string | no | |
| `timestamp` | ISO datetime | **yes** | When the reading was taken |
| `payload` | object | **yes** | Sensor-specific values (see below) |

**Payload conventions:**

The agent's trend calculation (`computeTrend` in `nalog.js`) looks for these
fields in order: `payload.level`, `payload.moisture`, `payload.value`. Use
whichever fits your sensor type:

| Sensor type | Payload example |
|---|---|
| Water level (AWD tube) | `{ "level": -12.3, "unit": "cm" }` |
| Soil moisture | `{ "moisture": 42.5, "unit": "%" }` |
| Generic numeric | `{ "value": 23.1, "unit": "°C" }` |

You can include additional fields — the agent passes the full `payload` to the
LLM, which can reason about any key/value it sees.

---

### `GET /api/paddies/:paddyId/awd-cycle`

Current AWD (Alternate Wetting and Drying) irrigation cycle. **Rice-specific.**
Return `null` or 404 if not applicable to your crop.

**Response:**

```json
{
  "data": {
    "cycleId": "awd-paddy3",
    "paddyId": "paddy-rice-3",
    "farmId": "farm-kutchum",
    "currentPhase": "draining",
    "cycleNumber": 3,
    "minWaterLevel": -15,
    "maxWaterLevel": 5,
    "active": true,
    "autoControlEnabled": true
  }
}
```

If your platform doesn't use AWD cycles, return `null`. The agent handles this
gracefully — it just won't mention AWD phases in its advice.

---

### `GET /api/farms/:farmId/pump-controls`

Pump control events (on/off commands sent to devices).

**Response:**

```json
{
  "data": [
    {
      "action": "start",
      "paddyId": "paddy-rice-3",
      "timestamp": "2026-07-15T08:30:00Z",
      "reason": "AWD reflooding",
      "triggeredBy": "agent"
    }
  ]
}
```

Return `[]` if your platform doesn't track pump controls.

---

### `GET /api/farms/:farmId/irrigation-events?limit=50`

### `GET /api/paddies/:paddyId/irrigation-events?limit=50`

Irrigation events (higher-level than pump controls — e.g. a full watering session).

**Response:**

```json
{
  "data": [
    {
      "eventType": "pump_start",
      "paddyId": "paddy-rice-3",
      "timestamp": "2026-07-15T08:30:00Z",
      "duration": 3600,
      "waterVolume": 150,
      "triggeredBy": "manual"
    }
  ]
}
```

Return `[]` if not available. The agent uses `lastWatering` and
`lastWateringByPaddy` (computed from whatever data is returned) to answer
questions like "when was this field last watered?"

---

## Minimum viable connector

If you're starting from scratch, the absolute minimum is:

1. **`GET /api/farms`** — at least one farm with `farmId` and `name`
2. **`GET /api/farms/:farmId/paddies`** — at least one field with `paddyId`,
   `farmId`, `name`, `cropType`
3. **`GET /api/farms/:farmId/sensors`** — at least one sensor with `sensorId`,
   `farmId`, `paddyId`, `type`
4. **`GET /api/sensors/:sensorId/data`** — sensor readings with `timestamp` and
   `payload`

Everything else can return `null` or `[]`. The agent will work with whatever
data it has and tell the user when information is unavailable.

---

## Testing your connector

1. Create your demo dataset in `src/integrations/demoData.js` matching your API
   shapes.
2. Run tests: `npm test` (uses demo data, no external calls).
3. Point to your live API:
   ```env
   NALOG_USE_DEMO=false
   NALOG_API_URL=https://your-api.example.com
   NALOG_AUTH_TOKEN=Bearer your-token
   ```
4. Run the selfcheck: `npm run check` — boots the agent and verifies endpoints.
5. Open the web UI at `http://localhost:8080` and ask the agent about your fields.
