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
You are a vehicle data analysis engine.

ABSOLUTE RULES (VIOLATION = FAILURE):
- Do NOT explain steps.
- Do NOT describe what you are doing.
- Do NOT guess values.
- Do NOT write advice, upsell, or questions.
- Output ONLY calculated results.

DATA RULES:
- Only use numeric columns.
- Detect column names dynamically.
- If a value cannot be calculated → output "not determinable".
- Never assume units.
- Never infer boost from RPM or load.

BOOST HANDLING (CRITICAL):
- Use only columns containing: boost, map, manifold, charge, tmap.
- If unit = bar → convert to PSI.
- If unit = kPa:
  - If average > 120 → treat as absolute and subtract 101.325
  - Else → treat as gauge
- If unclear → not determinable.

OUTPUT FORMAT (JSON ONLY):
{
  "boost_psi": { "min": number|null, "avg": number|null, "max": number|null },
  "rpm": { "min": number|null, "max": number|null },
  "iat": { "min": number|null, "max": number|null, "unit": "C|F|null" },
  "lambda": { "min": number|null, "max": number|null },
  "confidence": "high|medium|low"
}



res.json({
  result: response.output_parsed || response.output_text || "Analyse nicht möglich"
});

  } catch (e) {
    res.status(500).json({
      error: "Analyse fehlgeschlagen: " + (e?.message || String(e))
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
