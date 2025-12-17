import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import cors from "cors";
import OpenAI from "openai";
import Papa from "papaparse";

const app = express();
app.set("trust proxy", 1);

// ---------- CORS ----------
app.use(
  cors({
    origin: [
      "https://spicycarworks.com",
      "https://www.spicycarworks.com",
      "https://spicycarworks.myshopify.com",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.options("*", cors());

// ---------- Upload ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// ---------- Rate limit ----------
app.use(
  "/proxy/analyze",
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
  })
);

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Helpers ----------
function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectDelimiter(sampleLine) {
  const candidates = [",", ";", "\t", "|"];
  const counts = candidates.map((d) => ({
    d,
    c: (sampleLine.match(new RegExp(`\\${d}`, "g")) || []).length,
  }));
  counts.sort((a, b) => b.c - a.c);
  return counts[0]?.c > 0 ? counts[0].d : ",";
}

function looksLikeHeader(line, delim) {
  const parts = line.split(delim).map((p) => p.trim());
  if (parts.length < 3) return false;

  // header tends to have many non-numeric tokens
  let nonNumeric = 0;
  for (const p of parts) {
    const x = p.replace(/["']/g, "").trim();
    if (!x) continue;
    const n = Number(x.replace(",", "."));
    if (!Number.isFinite(n)) nonNumeric++;
  }
  return nonNumeric >= Math.max(2, Math.floor(parts.length * 0.4));
}

function findHeaderLineIndex(lines) {
  // scan first ~50 lines
  const maxScan = Math.min(lines.length, 50);
  let bestIdx = -1;
  let bestScore = -1;
  for (let i = 0; i < maxScan; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const delim = detectDelimiter(line);
    const parts = line.split(delim);
    const score = parts.length; // more columns usually = real header
    if (looksLikeHeader(line, delim) && score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function normalizeLogCsv(rawText) {
  const text = normalizeNewlines(rawText);
  const lines = text.split("\n");

  const headerIdx = findHeaderLineIndex(lines);
  if (headerIdx < 0) throw new Error("Header not found");

  const headerLine = lines[headerIdx];
  const delimiter = detectDelimiter(headerLine);

  const dataText = lines.slice(headerIdx).join("\n");

  // Parse with Papa (header: true)
  const parsed = Papa.parse(dataText, {
    header: true,
    delimiter,
    skipEmptyLines: true,
    dynamicTyping: false,
  });

  if (parsed.errors?.length) {
    // try again without forcing delimiter
    const parsed2 = Papa.parse(dataText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (!parsed2.data?.length) throw new Error("No usable rows");
    return {
      rows: parsed2.data,
      fields: parsed2.meta?.fields || Object.keys(parsed2.data[0] || {}),
      info: { headerIdx, detectedDelimiter: "auto", rows: parsed2.data.length },
    };
  }

  if (!parsed.data?.length) throw new Error("No usable rows");

  const fields = parsed.meta?.fields || Object.keys(parsed.data[0] || {});
  return {
    rows: parsed.data,
    fields,
    info: { headerIdx, detectedDelimiter: delimiter, rows: parsed.data.length },
  };
}

function normKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\-_()/[\].:%]/g, "");
}

function pickColumn(fields, candidates) {
  // returns { name, score } or null
  let best = null;
  for (const f of fields) {
    const fk = normKey(f);
    for (const c of candidates) {
      const ck = normKey(c);
      if (!ck) continue;
      let score = 0;
      if (fk === ck) score = 100;
      else if (fk.includes(ck) || ck.includes(fk)) score = 60;
      else if (fk.startsWith(ck) || ck.startsWith(fk)) score = 50;
      if (score > (best?.score || 0)) best = { name: f, score };
    }
  }
  return best && best.score >= 40 ? best : null;
}

function toNumberLoose(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function sampleRows(rows, max = 400) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  return out;
}

function minMax(arr) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const v of arr) {
    if (!Number.isFinite(v)) continue;
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!count) return null;
  return { min, max, count };
}

function detectPressureUnit(series) {
  // crude unit guess from value ranges
  // psi boost often 0..40 (gauge) or 14..55 (absolute)
  // kPa often 80..300, bar often 0.8..3.0 (abs) or 0..2.5 (gauge)
  const stats = minMax(series);
  if (!stats) return { unit: null, kind: null };

  const { min, max } = stats;

  if (max <= 5 && min >= 0) return { unit: "bar", kind: "pressure" };
  if (max > 50 && max <= 400) return { unit: "kPa", kind: "pressure" };
  if (max > 5 && max <= 120) return { unit: "psi", kind: "pressure" };

  return { unit: null, kind: "pressure" };
}

function pressureToPsi(v, unit) {
  if (!Number.isFinite(v)) return null;
  if (unit === "psi") return v;
  if (unit === "kPa") return v * 0.1450377;
  if (unit === "bar") return v * 14.50377;
  return null;
}

function likelyAbsolutePressurePsi(psiStats) {
  // if minimum sits near atmospheric absolute (~14.7 psi), it's probably absolute
  if (!psiStats) return false;
  return psiStats.min > 10 && psiStats.min < 18;
}

// ---------- Routes ----------
app.get("/proxy", (req, res) => res.send("Personal Assistant Backend läuft"));
app.get("/", (req, res) => res.send("OK"));

app.post("/proxy/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine CSV-Datei erhalten." });
    const note = (req.body?.note || "").toString();

    // 1) Normalize & parse locally
    const rawText = req.file.buffer.toString("utf8");
    let norm;
    try {
      norm = normalizeLogCsv(rawText);
    } catch (e) {
      return res.json({
        text:
          "Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter.\n\n" +
          "Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren.",
      });
    }

    const { rows, fields, info } = norm;

    // 2) Detect columns (best-effort, different loggers supported)
    const colTime = pickColumn(fields, ["time", "timestamp", "t", "zeit", "sec", "s"]);
    const colRpm = pickColumn(fields, ["rpm", "engine rpm", "motordrehzahl", "n", "enginerpm"]);
    const colPedal = pickColumn(fields, ["pedal", "accelerator", "accel", "ap", "gaspedal", "pedalpos"]);
    const colThrottle = pickColumn(fields, ["throttle", "throttlepos", "drossel", "tp", "throttle angle"]);
    const colBoost = pickColumn(fields, ["boost", "map", "manifold", "charge", "ld", "saugrohr", "pressure", "boostpsi", "mapkpa"]);
    const colIat = pickColumn(fields, ["iat", "intake", "ansaugluft", "intake air", "charge air temp"]);
    const colLambda = pickColumn(fields, ["lambda", "afr", "wideband", "o2", "equivalence"]);
    const colIgn = pickColumn(fields, ["ign", "timing", "spark", "zw", "zünd", "ignition", "spark advance"]);

    // 3) Build numeric arrays
    const rpmArr = colRpm ? rows.map((r) => toNumberLoose(r[colRpm.name])) : [];
    const pedalArr = colPedal ? rows.map((r) => toNumberLoose(r[colPedal.name])) : [];
    const throttleArr = colThrottle ? rows.map((r) => toNumberLoose(r[colThrottle.name])) : [];

    const boostRawArr = colBoost ? rows.map((r) => toNumberLoose(r[colBoost.name])) : [];
    const iatArr = colIat ? rows.map((r) => toNumberLoose(r[colIat.name])) : [];
    const lambdaArr = colLambda ? rows.map((r) => toNumberLoose(r[colLambda.name])) : [];
    const ignArr = colIgn ? rows.map((r) => toNumberLoose(r[colIgn.name])) : [];

    // 4) WOT detection (pedal OR throttle)
    const wotMask = rows.map((_, i) => {
      const p = pedalArr[i];
      const t = throttleArr[i];
      // treat 90+ as WOT, also handle 0..1 normalized
      const pW = Number.isFinite(p) ? (p <= 1.2 ? p >= 0.9 : p >= 90) : false;
      const tW = Number.isFinite(t) ? (t <= 1.2 ? t >= 0.9 : t >= 90) : false;
      return pW || tW;
    });

    function filterByMask(arr, mask) {
      const out = [];
      for (let i = 0; i < arr.length; i++) if (mask[i]) out.push(arr[i]);
      return out;
    }

    // 5) Pressure interpretation (boost column could be psi/kPa/bar and abs vs gauge)
    let boostPsiArr = [];
    let boostPsiGaugeArr = [];
    let boostMeta = { detected: null, absoluteLikely: null, unit: null };

    if (colBoost) {
      const unitGuess = detectPressureUnit(boostRawArr);
      boostMeta.unit = unitGuess.unit;

      boostPsiArr = boostRawArr.map((v) => pressureToPsi(v, unitGuess.unit)).filter((v) => v !== null);

      const psiStats = minMax(boostPsiArr);
      const absLikely = likelyAbsolutePressurePsi(psiStats);
      boostMeta.absoluteLikely = absLikely;

      if (absLikely) {
        // gauge = abs - 14.7 psi
        boostPsiGaugeArr = boostRawArr
          .map((v) => pressureToPsi(v, unitGuess.unit))
          .map((v) => (v === null ? null : v - 14.7))
          .filter((v) => v !== null);
      } else {
        boostPsiGaugeArr = boostRawArr.map((v) => pressureToPsi(v, unitGuess.unit)).filter((v) => v !== null);
      }

      boostMeta.detected = colBoost.name;
    }

    // 6) Stats full + WOT
    const stats = {
      meta: {
        rows: rows.length,
        headerIdx: info.headerIdx,
        delimiter: info.detectedDelimiter,
        detectedColumns: {
          time: colTime?.name || null,
          rpm: colRpm?.name || null,
          pedal: colPedal?.name || null,
          throttle: colThrottle?.name || null,
          boost: colBoost?.name || null,
          iat: colIat?.name || null,
          lambda: colLambda?.name || null,
          ignition: colIgn?.name || null,
        },
        boostInterpretation: boostMeta,
        noteFromUser: note || null,
      },
      full: {
        rpm: minMax(rpmArr),
        iat: minMax(iatArr),
        lambda: minMax(lambdaArr),
        ignition: minMax(ignArr),
        boostPsiGauge: minMax(boostPsiGaugeArr),
      },
      wot: {
        rpm: minMax(filterByMask(rpmArr, wotMask)),
        iat: minMax(filterByMask(iatArr, wotMask)),
        lambda: minMax(filterByMask(lambdaArr, wotMask)),
        ignition: minMax(filterByMask(ignArr, wotMask)),
        boostPsiGauge: minMax(filterByMask(
          // need aligned array for mask (rebuild aligned gauge series)
          colBoost
            ? boostRawArr.map((v) => {
                const psi = pressureToPsi(v, boostMeta.unit);
                if (psi === null) return null;
                return boostMeta.absoluteLikely ? psi - 14.7 : psi;
              })
            : [],
          wotMask
        )),
      },
    };

    // 7) Provide the model a small dataset (downsample) to reason about relationships
    // keep only a reasonable subset of columns to reduce tokens
    const keepCols = [
      colTime?.name,
      colRpm?.name,
      colPedal?.name,
      colThrottle?.name,
      colBoost?.name,
      colIat?.name,
      colLambda?.name,
      colIgn?.name,
    ].filter(Boolean);

    const compactRows = rows.map((r, i) => {
      const o = { __wot: wotMask[i] ? 1 : 0 };
      for (const k of keepCols) o[k] = r[k];
      return o;
    });

    const sampleAll = sampleRows(compactRows, 500);
    const sampleWot = sampleRows(compactRows.filter((r) => r.__wot === 1), 300);

    const payloadForModel = {
      stats,
      sample_all: sampleAll,
      sample_wot: sampleWot,
    };

    // 8) Ask GPT (NO code interpreter, NO file upload)
    const instructions = `
ENGLISH (output first):
You are the SpicyCarWorks Log Assistant.
You MUST base every numeric statement ONLY on the provided computed stats in JSON ("stats") and/or values visible in "sample_all/sample_wot". NEVER guess.
If required columns are missing, explicitly say which ones are missing and avoid conclusions.

Output format EXACTLY:
1) Summary (2-4 bullet points, customer-friendly, no jargon)
2) Key numbers (bullets; include FULL and WOT min/max when available for: Boost (psi gauge), RPM, IAT, Lambda/AFR, Ignition)
3) Findings (Fueling / Timing / Boost / IAT) — only if relevant data exists
4) Next steps (max 5 bullets)

NO sales, NO upsell, NO “contact us”, NO marketing.
Language: English first, then German.

DEUTSCH (output second):
Du bist der SpicyCarWorks Log Assistant.
Du MUSST jede numerische Aussage NUR auf den bereitgestellten berechneten Werten in JSON ("stats") und/oder auf sichtbaren Werten in "sample_all/sample_wot" stützen. NIEMALS raten.
Wenn Spalten fehlen, sage klar welche fehlen und ziehe keine falschen Schlüsse.

Ausgabeformat GENAU:
1) Kurzfazit (2-4 Bullets, kundenfreundlich)
2) Key Numbers (Bullets; FULL und WOT min/max wenn vorhanden: Boost (psi gauge), RPM, IAT, Lambda/AFR, Ignition)
3) Findings (Fueling / Timing / Boost / IAT) — nur wenn Daten vorhanden
4) Next Steps (max 5 Bullets)

KEIN Verkaufston, KEIN Upsell, KEIN “contact us”, KEIN Marketing.
Sprache: zuerst Englisch, dann Deutsch.
`.trim();

    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instructions },
            {
              type: "input_text",
              text:
                "Here is the normalized log payload (JSON). Use this ONLY:\n" +
                JSON.stringify(payloadForModel),
            },
          ],
        },
      ],
    });

    res.json({ text: response.output_text || "Keine Ausgabe." });
  } catch (e) {
    res.status(500).json({ error: "Analyse fehlgeschlagen: " + (e?.message || String(e)) });
  }
});

// ---------- Listen ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
