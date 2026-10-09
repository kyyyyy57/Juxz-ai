
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { rateLimit } from "express-rate-limit";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.disable("x-powered-by");

// Sesuaikan jika nanti menggunakan proxy sendiri.
// Vercel menyediakan informasi IP melalui proxy.
app.set("trust proxy", 1);

app.use(express.json({ limit: "32kb" }));

// Batas dasar: 15 request per menit per IP.
// Pada serverless, batas memori ini tidak dibagi antarinvokasi.
app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Terlalu banyak permintaan. Tunggu sebentar."
    }
  })
);

// Menyajikan file website dari folder public.
app.use(express.static(path.join(root, "public")));

// Endpoint untuk mengecek status backend tanpa membocorkan API key.
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(process.env.GEMINI_API_KEY)
  });
});

// Endpoint percakapan AI.
app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "Gemini API belum dikonfigurasi oleh admin."
      });
    }

    const input = req.body?.messages;

    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({
        error: "Pesan percakapan wajib diisi."
      });
    }

    if (input.length > 20) {
      return res.status(400).json({
        error: "Maksimal 20 pesan dalam satu permintaan."
      });
    }

    const contents = input.map((item) => {
      if (
        !item ||
        !["user", "model"].includes(item.role) ||
        typeof item.text !== "string"
      ) {
        throw new Error("INVALID_MESSAGE");
      }

      const text = item.text.trim();

      if (!text || text.length > 6000) {
        throw new Error("INVALID_MESSAGE");
      }

      return {
        role: item.role,
        parts: [{ text }]
      };
    });

    if (contents[contents.length - 1].role !== "user") {
      return res.status(400).json({
        error: "Pesan terakhir harus berasal dari pengguna."
      });
    }

    const ai = new GoogleGenAI({ apiKey });

    const result = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction:
          "Kamu adalah JUXZ AI, asisten AI yang ramah dan membantu. " +
          "Jawab menggunakan bahasa pengguna. " +
          "Bantu dalam belajar, coding, matematika, dan kreativitas. " +
          "Jika tidak yakin, katakan dengan jujur.",
        maxOutputTokens: 2048,
        temperature: 0.7
      }
    });

    const answer = result.text?.trim();

    if (!answer) {
      return res.status(502).json({
        error: "AI tidak menghasilkan jawaban. Coba pertanyaan lain."
      });
    }

    return res.json({
      answer,
      model: MODEL
    });
  } catch (error) {
    if (error.message === "INVALID_MESSAGE") {
      return res.status(400).json({
        error: "Format pesan salah atau pesan terlalu panjang."
      });
    }

    const status = Number(error.status || error.statusCode || 0);

    // Detail dicatat hanya di log server, tidak ditampilkan ke pengunjung.
    console.error("Gemini request failed:", {
      status,
      message: String(error.message || "Unknown error").slice(0, 250)
    });

    if (status === 429) {
      return res.status(429).json({
        error: "Kuota Gemini tercapai. Coba lagi nanti."
      });
    }

    if (status === 401 || status === 403) {
      return res.status(502).json({
        error: "API key atau izin Gemini bermasalah. Admin perlu memeriksanya."
      });
    }

    if (status === 404) {
      return res.status(502).json({
        error: "Model Gemini tidak ditemukan. Admin perlu memeriksa nama model."
      });
    }

    return res.status(502).json({
      error: "Gagal menghubungi Gemini. Periksa koneksi atau coba lagi."
    });
  }
});

// Penanganan JSON rusak dan error middleware.
app.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({
      error: "Data permintaan terlalu besar."
    });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      error: "Format JSON tidak valid."
    });
  }

  console.error("Server error:", error.message);

  return res.status(500).json({
    error: "Terjadi kesalahan pada server."
  });
});

// Vercel akan menjalankan server Express ini.
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`JUXZ AI berjalan di port ${PORT}`);
  });
}

export default app;
