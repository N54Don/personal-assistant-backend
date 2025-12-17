import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import cors from "cors";
import Papa from "papaparse";

const app = express();
app.set("trust proxy", 1);

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

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

app.use(
  "/proxy/analyze",
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
  })
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/proxy", (req, res) => res.send("Personal Assistent Backend läuft"));

/** ---------- Helpers ---------- **/
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function pickColumn(columns, keywords) {
  // columns: original names array
  const ncols = columns.map((c) => ({ orig: c, n: norm(c) }));
  for (const kw of keywords) {
    const nkw = norm(kw);
    const exact = ncols.find((c) => c.n === nkw);
    if (exact) return exact.orig;
  }
  // contains match
  for (const kw of keywords) {
    const nkw = norm(kw);
    const hit = ncols.find((c) => c.n.includes(nkw));
    if (hit) return hit.orig;
  }
  return null;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // support comma decimals
  const cleaned = s.replace(",", ".");
  const x = Number(cleaned);
  return Number.isFinite(x) ? x : null;
}

function stats(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  let min = a[0], max = a[0], sum = 0;
  for (const x of a) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { min, max, avg: sum / a.length, n: a.length };
}

function detectBoostUnit(colName, values) {
  const n = norm(colName);
  const s = stats(values);
  if (!s) return { unit: null, kind: null };

  // name-based
  if (n.includes("kpa")) return { unit: "kpa", kind: "pressure" };
  if (n.includes("bar")) return { unit: "bar", kind: "pressure" };
  if (n.includes("psi")) return { unit: "psi", kind: "pressure" };

  // value-based heuristic
  // kPa absolute usually ~80..300
  if (s.max > 60 && s.max < 500) return { unit: "kpa", kind: "pressure" };
  // bar absolute usually ~0.8..3.5
  if (s.max > 0.5 && s.max < 6) return { unit: "bar", kind: "pressure" };
  // psi usually ~0..60
  if (s.max > 6 && s.max < 120) return { unit: "psi", kind: "pressure" };

  return { unit: null, kind: null };
}

function pressureToPsi(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (unit === "psi") return value;
  if (unit === "kpa") return value * 0.1450377;
  if (unit === "bar") return value * 14.50377;
  return null;
}

function isProbablyAbsolutePressurePsi(psiStats) {
  // If minimum is near atmospheric (≈14.7 psi) or (kPa~101), it's likely absolute.
  // In psi domain: abs pressure at idle often ~13..16 psi. Boosted might go to 30-45 psi abs.
  if (!psiStats) return false;
  return psiStats.min > 10 && psiStats.min < 18;
}

/** ---------- Main analyze endpoint ---------- **/
app.post("/proxy/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine CSV-Datei erhalten." });

    const note = (req.body?.note || "").toString();

    // 1) Parse CSV locally (NO OpenAI file upload)
    const csvText = req.file.buffer.toString("utf8");

    const parsed = Papa.parse(csvText, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
      transformHeader: (h) => String(h || "").trim(),
    });

    if (parsed.errors?.length) {
      return res.json({
        text:
          "Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter.\n\n" +
          "Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren.",
      });
    }

    const rows = parsed.data || [];
    const columns = parsed.meta?.fields || [];

    if (!rows.length || !columns.length) {
      return res.json({
        text:
          "Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter.\n\n" +
          "Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren.",
      });
    }

    // 2) Auto-detect columns
    const colRPM = pickColumn(columns, ["rpm", "engine speed", "enginespeed"]);
    const colPedal = pickColumn(columns, ["pedal", "accelerator", "acc pedal", "throttle", "throttlepos", "tp", "driver demand"]);
    const colIAT = pickColumn(columns, ["iat", "intake air temp", "intakeairtemp", "charge air temp", "tmap", "imtemp"]);
    const colLambda = pickColumn(columns, ["lambda", "afr", "wideband", "bank1lambda", "lambdawert"]);
    const colIgn = pickColumn(columns, ["ignition", "timing", "spark", "zwinkel", "ign", "ignition timing"]);
    const colBoost = pickColumn(columns, [
      "boost",
      "boostpsi",
      "manifold",
      "map",
      "tmap",
      "charge pressure",
      "intake manifold pressure",
      "boost actual",
      "boost target",
      "pressure",
    ]);

    // 3) Extract numeric arrays
    const rpm = colRPM ? rows.map((r) => toNum(r[colRPM])) : [];
    const pedal = colPedal ? rows.map((r) => toNum(r[colPedal])) : [];
    const iat = colIAT ? rows.map((r) => toNum(r[colIAT])) : [];
    const lambda = colLambda ? rows.map((r) => toNum(r[colLambda])) : [];
    const ign = colIgn ? rows.map((r) => toNum(r[colIgn])) : [];
    const boostRaw = colBoost ? rows.map((r) => toNum(r[colBoost])) : [];

    // 4) Boost normalization
    let boostInfo = null;
    if (colBoost) {
      const { unit } = detectBoostUnit(colBoost, boostRaw);
      const boostPsiAbs = boostRaw.map((v) => pressureToPsi(v, unit));
      const sAbs = stats(boostPsiAbs);

      let gaugePsi = null;
      let sGauge = null;
      if (isProbablyAbsolutePressurePsi(sAbs)) {
        // abs -> gauge
        gaugePsi = boostPsiAbs.map((v) => (Number.isFinite(v) ? v - 14.6959 : null));
        sGauge = stats(gaugePsi);
      }

      boostInfo = {
        column: colBoost,
        unitDetected: unit,
        psiAbsolute: sAbs ? { min: sAbs.min, max: sAbs.max } : null,
        psiGauge: sGauge ? { min: sGauge.min, max: sGauge.max } : null,
        isAbsoluteLikely: isProbablyAbsolutePressurePsi(sAbs),
      };
    }

    // 5) Load state (part/full) heuristic
    // Full load if pedal/throttle >= 90% OR (pedal missing) rpm high and boost high
    const pedalStats = stats(pedal);
    const rpmStats = stats(rpm);

    let fullLoadPct = null;
    if (pedal.length) {
      const valid = pedal.filter((x) => Number.isFinite(x));
      if (valid.length) {
        const full = valid.filter((x) => x >= 90).length;
        fullLoadPct = (full / valid.length) * 100;
      }
    }

    // 6) Prepare computed metrics (ONLY numbers from here)
    const metrics = {
      fileName: req.file.originalname,
      note,
      detectedColumns: {
        rpm: colRPM,
        pedalOrThrottle: colPedal,
        iat: colIAT,
        lambdaOrAfr: colLambda,
        ignitionOrTiming: colIgn,
        boostOrPressure: colBoost,
      },
      rpm: rpmStats ? { min: rpmStats.min, max: rpmStats.max } : null,
      pedal: pedalStats ? { min: pedalStats.min, max: pedalStats.max } : null,
      iat: stats(iat) ? { min: stats(iat).min, max: stats(iat).max } : null,
      lambda: stats(lambda) ? { min: stats(lambda).min, max: stats(lambda).max } : null,
      ignition: stats(ign) ? { min: stats(ign).min, max: stats(ign).max } : null,
      boost: boostInfo,
      fullLoadPercent: fullLoadPct,
    };

    // 7) Let GPT write CUSTOMER-FRIENDLY text from computed metrics
    const prompt = `
You are SpicyCarWorks Log Assistant.

IMPORTANT:
- You receive ONLY computed metrics as JSON below.
- You MUST NOT invent numbers, columns, or conclusions beyond these metrics.
- If something is missing/null, say "not available".

Output MUST be:
ENGLISH first, then GERMAN.

Format EXACT:
1) Summary (2-4 bullets, customer-friendly)
2) Key numbers (bullets like a mini table)
3) Load state (part-throttle vs WOT) based only on pedal/fullLoadPercent if available
4) Next steps (max 5 bullets)
NO sales/upsell, NO "contact us", NO marketing.

JSON METRICS:
${JSON.stringify(metrics, null, 2)}
`.trim();

    const ai = await openai.responses.create({
      model: "gpt-4.1",
      input: prompt,
    });

    res.json({ text: ai.output_text || "Keine Ausgabe." });
  } catch (e) {
    res.status(500).json({ error: "Analyse fehlgeschlagen: " + (e?.message || String(e)) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
