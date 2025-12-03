const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

// NETTOYAGE MAGIQUE DE LA CLÉ (Enlève les espaces invisibles)
const API_KEY_GEMINI = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN ? process.env.MY_SECRET_TOKEN.trim() : "";

app.get('/', (req, res) => res.send('Usine OK (V1.5 Clean)'));

app.post('/process', (req, res, next) => {
    console.log("📨 REQUÊTE REÇUE !");
    next();
}, upload.single('image'), async (req, res) => {
    
    // 1. SÉCURITÉ
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).json({ error: 'Mauvais token.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Pas de fichier image.' });

    try {
        console.log(`✅ Image acceptée : ${req.file.originalname}`);
        const inputBuffer = req.file.buffer;
        const tasks = [];

        // Tâche A : AVIF
        const sizes = [
            { name: 'mobile', width: 480 },
            { name: 'tablet', width: 768 },
            { name: 'desktop', width: 1280 },
            { name: 'large', width: 1920 }
        ];

        sizes.forEach(size => {
            tasks.push(
                sharp(inputBuffer)
                    .resize({ width: size.width, withoutEnlargement: true })
                    .toFormat('avif', { quality: 60, effort: 3 })
                    .toBuffer()
                    .then(buffer => ({ type: 'image', size: size.name, data: buffer.toString('base64') }))
                    .catch(err => { console.error(`Erreur Sharp ${size.name}:`, err); return null; })
            );
        });

        // Tâche B : IA (Modèle 1.5 Flash avec protection anti-crash)
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    
                    const result = await model.generateContent([
                        "SEO Expert. JSON {title, alt, description}. Français.",
                        { inlineData: { data: inputBuffer.toString('base64'), mimeType: req.file.mimetype } }
                    ]);
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    return { type: 'seo', data: JSON.parse(text) };
                } catch (err) {
                    // C'est ici que l'erreur sera attrapée sans faire planter l'usine
                    console.error("⚠️ L'IA a échoué (Ignoré):", err.message);
                    return { type: 'seo', data: null };
                }
            })());
        }

        const results = await Promise.all(tasks);
        const responseData = { images: {}, seo: null };

        results.forEach(item => {
            if (!item) return;
            if (item.type === 'image') responseData.images[item.size] = item.data;
            if (item.type === 'seo') responseData.seo = item.data;
        });

        res.json(responseData);

    } catch (error) {
        console.error("❌ Erreur Critique Serveur:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000; // Render utilise souvent le port 10000
app.listen(PORT, () => console.log(`Usine démarrée sur le port ${PORT}`));
