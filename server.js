const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

// On désactive le parseur JSON par défaut pour éviter les conflits avec Multer
// app.use(express.json({ limit: '50mb' })); 

const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

app.get('/', (req, res) => res.send('Usine OK'));

app.post('/process', (req, res, next) => {
    // 0. MOUCHARD : On logue tout ce qui arrive AVANT de traiter
    console.log("📨 REQUÊTE REÇUE !");
    console.log("Headers Content-Type:", req.headers['content-type']);
    console.log("Token reçu:", req.headers['authorization'] ? "OUI" : "NON");
    next();
}, upload.single('image'), async (req, res) => {
    
    // 1. Check Sécurité
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        console.error("⛔ Refusé : Mauvais token");
        return res.status(403).json({ error: 'Accès refusé. Mauvais token.' });
    }

    // 2. Check Fichier
    if (!req.file) {
        console.error("⛔ Refusé : Pas de fichier 'image' trouvé dans le paquet.");
        return res.status(400).json({ error: 'Fichier image manquant ou mal formé.' });
    }

    try {
        console.log(`✅ Image acceptée : ${req.file.originalname} (${req.file.size} bytes)`);
        
        // --- DÉBUT DU TRAITEMENT ---
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

        // Tâche B : IA (Gemini 2.5)
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    const result = await model.generateContent([
                        "SEO Expert. JSON {title, alt, description}. Français.",
                        { inlineData: { data: inputBuffer.toString('base64'), mimeType: req.file.mimetype } }
                    ]);
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    return { type: 'seo', data: JSON.parse(text) };
                } catch (err) {
                    console.error("⚠️ Erreur IA:", err.message);
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
        console.error("❌ Erreur Critique:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Usine sur port ${PORT}`));
