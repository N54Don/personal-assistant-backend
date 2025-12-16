// server.js
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import cors from "cors";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const app = express();

// IMPORTANT for Render / proxies (fixes x-forwarded-for + rate-limit)
app.set("trust proxy", 1);

// CORS (Shopify storefront + your domains)
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

// Upload (20MB)
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// Rate limit (per IP)
app.use(
  "/proxy/analyze",
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health check
app.get("/proxy", (req, res) => res.send("Personal Assistant Backend läuft"));

// Analyze endpoint
app.post("/proxy/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine CSV-Datei erhalten." });
    }

    const note = req.body?.note || "";

    // Upload file to OpenAI
    const f = await toFile(req.file.buffer, req.file.originalname || "log.csv");
    const uploaded = await openai.files.create({
      file: f,
      purpose: "assistants",
    });

    // IMPORTANT: attach the file as input_file (so Code Interpreter can actually read it)
    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [
  {
    type: "code_interpreter",
    container: { type: "auto", file_ids: [uploaded.id] },
  },
],
      instructions: `
ENGLISH (output first):
You are the SpicyCarWorks Log Assistant.
You MUST base every numeric statement ONLY on values you actually computed from the uploaded file using Python (pandas) in Code Interpreter. NEVER guess.
If parsing fails or you cannot confidently identify columns/units, output ONLY:
"Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter."
and stop.

Rules (output format exactly):
1) Summary (2–4 bullets, customer-friendly, no jargon)
2) Key numbers (bullets) — ALWAYS include min/max for detected Boost, RPM, IAT, Lambda/AFR (only if columns exist)
3) Findings (Fueling / Timing / Boost / IAT) — only if relevant columns exist
4) Next steps (max 5 bullets)
- NO sales, NO upsell, NO "contact us", NO marketing.
- Language: English first, then German.

Boost handling:
- Detect a boost-related column automatically (by column name similarity + value ranges).
- Determine units if possible (psi / kPa / bar). If kPa appears, convert to psi (psi = kPa * 0.1450377).
- If data looks like absolute pressure (~100 kPa at idle), also compute gauge boost by subtracting ~101.3 kPa (or equivalent).
- If unit/absolute-vs-gauge cannot be determined, say so and do NOT claim a boost value.

DEUTSCH (output second):
Du bist der SpicyCarWorks Log Assistant.
Du MUSST jede numerische Aussage NUR auf Werten basieren, die du wirklich aus der hochgeladenen Datei mit Python (pandas) im Code Interpreter berechnet hast. NIEMALS raten.
Wenn Parsing scheitert oder Spalten/Einheiten nicht sicher erkennbar sind, gib NUR aus:
"Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren."
und stoppe.

Regeln (Ausgabeformat exakt):
1) Kurzfazit (2–4 Bulletpoints, kundenfreundlich, ohne Fachchinesisch)
2) Key Numbers (Bullets) — IMMER min/max für erkannten Boost, RPM, IAT, Lambda/AFR (nur wenn Spalten existieren)
3) Findings (Fueling / Timing / Boost / IAT) — nur wenn passende Spalten existieren
4) Next Steps (max 5 Bullets)
- KEIN Verkaufston, KEIN Upsell, KEIN "contact us", KEIN Marketing.
- Sprache: zuerst Englisch, dann Deutsch.

Boost:
- Boost-Spalte automatisch erkennen (Spaltenname + Wertebereich).
- Einheit bestimmen wenn möglich (psi / kPa / bar). Bei kPa -> in psi umrechnen (psi = kPa * 0.1450377).
- Wenn Werte nach Absolutdruck aussehen (~100 kPa im Leerlauf), zusätzlich Gauge-Boost berechnen (minus ~101,3 kPa bzw. äquivalent).
- Wenn Einheit/absolut-vs-gauge nicht bestimmbar ist: sagen und KEINEN Boostwert behaupten.
      `.trim(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Zusatzinfos vom Nutzer: ${note}\nAnalysiere den angehängten Log.`,
            },
            { type: "input_file", file_id: uploaded.id },
          ],
        },
      ],
    });

    return res.json({ text: response.output_text || "Keine Ausgabe." });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "Analyse fehlgeschlagen: " + (e?.message || String(e)) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));

