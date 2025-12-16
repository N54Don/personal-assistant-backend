import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import cors from "cors";

const app = express();
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
      model: "gpt-4.1-mini",
      tools: [{
        type: "code_interpreter",
        container: { type: "auto", file_ids: [uploaded.id] }
      }],
      instructions: `
Du bist der "Personal Assistent" von SpicyCarWorks.
Kurzfazit, Flags (Fueling/Timing/Boost/IAT), Next Steps.
Deutsch, kurz, technisch. Kein Verkaufston.
Upsell nur wenn echte Auffälligkeiten. Max 1 Satz am Ende.
`,
      input: `Zusatzinfos vom Nutzer: ${note}\nAnalysiere den angehängten Log.`
    });

    res.json({ text: response.output_text || "Keine Ausgabe." });
  } catch (e) {
    res.status(500).json({ error: "Analyse fehlgeschlagen: " + (e?.message || String(e)) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
