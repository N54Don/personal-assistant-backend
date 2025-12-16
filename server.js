import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import cors from "cors";

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: [
    "https://spicycarworks.com",
    "https://www.spicycarworks.com",
    "https://spicycarworks.myshopify.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.options("*", cors());

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

app.use("/proxy/analyze", rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
}));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/proxy", (req, res) => res.send("Personal Assistent Backend läuft"));

app.post("/proxy/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine CSV-Datei erhalten." });
    const note = req.body?.note || "";

    // 1) Upload CSV to OpenAI Files API
    const f = await toFile(req.file.buffer, req.file.originalname || "log.csv");
    const uploaded = await openai.files.create({
      file: f,
      purpose: "assistants"
    });

    // 2) Run Code Interpreter with that file available in the container
    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [{
        type: "code_interpreter",
        container: { type: "auto", file_ids: [uploaded.id] }
      }],
      instructions: `
ENGLISH (output first):
You are the SpicyCarWorks Log Assistant.
You MUST base every numeric statement ONLY on values you actually computed from the uploaded file in code interpreter (pandas). NEVER guess.
If parsing fails or you cannot confidently identify columns/units, output ONLY:
"Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter."
and stop.

Rules:
- Output format exactly:
  1) Summary (2-4 bullet points, customer-friendly, no jargon)
  2) Key numbers (table-like bullets) – ALWAYS include min/max for detected Boost, RPM, IAT, Lambda/AFR (only if columns exist)
  3) Findings (Fueling / Timing / Boost / IAT) – only if the relevant columns exist
  4) Next steps (max 5 bullets)
- NO sales, NO upsell, NO “contact us”, NO marketing.
- Language: English first, then German.
- Boost handling:
  - Detect the boost-related column automatically (by column name similarity + value ranges).
  - Determine units if possible (psi / kPa / bar). If kPa appears, convert to psi (psi = kPa * 0.1450377).
  - If the data looks like absolute pressure (e.g., around 100 kPa at idle), also compute gauge boost by subtracting ~101.3 kPa (or equivalent), and clearly label both.
  - If unit/absolute-vs-gauge cannot be determined, say so and do NOT claim a boost value.

DEUTSCH (output second):
Du bist der SpicyCarWorks Log Assistant.
Du MUSST jede numerische Aussage NUR auf Werten basieren, die du wirklich aus der hochgeladenen Datei im Code Interpreter (pandas) berechnet hast. NIEMALS raten.
Wenn das Parsing scheitert oder Spalten/Einheiten nicht sicher erkennbar sind, gib NUR aus:
"Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren."
und stoppe.

Regeln:
- Ausgabeformat exakt:
  1) Kurzfazit (2-4 Bulletpoints, kundenfreundlich, ohne Fachchinesisch)
  2) Key Numbers (wie Tabelle als Bullets) – IMMER min/max für erkannten Boost, RPM, IAT, Lambda/AFR (nur wenn Spalten existieren)
  3) Findings (Fueling / Timing / Boost / IAT) – nur wenn passende Spalten existieren
  4) Next Steps (max 5 Bullets)
- KEIN Verkaufston, KEIN Upsell, KEIN “contact us”, KEIN Marketing.
- Sprache: zuerst Englisch, dann Deutsch.
- Boost:
  - Boost-Spalte automatisch erkennen (Spaltenname + Wertebereich).
  - Einheit bestimmen wenn möglich (psi / kPa / bar). Bei kPa → in psi umrechnen (psi = kPa * 0.1450377).
  - Wenn Werte nach Absolutdruck aussehen (z.B. ~100 kPa im Leerlauf), zusätzlich Gauge-Boost berechnen (minus ~101,3 kPa bzw. äquivalent) und beides klar labeln.
  - Wenn Einheit/absolut-vs-gauge nicht bestimmbar ist: sagen und KEINEN Boostwert behaupten.


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
