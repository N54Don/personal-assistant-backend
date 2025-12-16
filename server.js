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

    // IMPORTANT:
    // Customers can upload .csv, but OpenAI "input_file" currently rejects .csv as a filename.
    // So we keep the CONTENT as-is, but rename the filename to .txt.
    const originalName = req.file.originalname || "log.csv";
    const safeName = originalName.replace(/\.csv$/i, ".txt");

    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [{ type: "code_interpreter" }],
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "ENGLISH (output first):\n" +
                "You are the SpicyCarWorks Log Assistant.\n" +
                "You MUST compute numbers from the uploaded file using code interpreter (pandas). NEVER guess.\n" +
                "If parsing fails or you cannot confidently identify columns/units, output ONLY:\n" +
                "\"Could not parse this file reliably. Please export as CSV with a single header row and consistent delimiter.\"\n" +
                "Output format:\n" +
                "1) Summary (2-4 bullets, customer-friendly)\n" +
                "2) Key numbers (bullets) include min/max for detected Boost, RPM, IAT, Lambda/AFR (only if columns exist)\n" +
                "3) Findings (Fueling/Timing/Boost/IAT) only if columns exist\n" +
                "4) Next steps (max 5 bullets)\n" +
                "NO sales, NO upsell, NO marketing.\n\n" +
                "DEUTSCH (output second):\n" +
                "Du bist der SpicyCarWorks Log Assistant.\n" +
                "Du MUSST Zahlen aus der Datei per Code Interpreter (pandas) berechnen. NIEMALS raten.\n" +
                "Wenn Parsing unsicher ist, gib NUR aus:\n" +
                "\"Konnte die Datei nicht zuverlässig einlesen. Bitte als CSV mit einer einzigen Header-Zeile und konsistentem Trennzeichen exportieren.\"\n" +
                "Format wie oben, kein Verkauf, kein Upsell.\n\n" +
                "User note: " + note
            },
            {
              type: "input_file",
              filename: safeName,
              data: req.file.buffer
            }
          ]
        }
      ]
    });

    return res.json({ text: response.output_text || "Keine Ausgabe." });
  } catch (e) {
    return res.status(500).json({
      error: "Analyse fehlgeschlagen: " + (e?.message || String(e))
    });
  }
});
