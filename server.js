const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// On accepte des images jusqu'à 20Mo
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

app.use(express.json({ limit: '50mb' }));

const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

app.get('/', (req, res) => res.send('Usine à Images (Gemini 2.5) Prête 🚀'));

app.post('/process', upload.single('image'), async (req, res) => {
    // 1. SÉCURITÉ
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).json({ error: 'Accès refusé. Mauvais token.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Pas d\'image reçue.' });

    try {
        const inputBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        const originalName = req.file.originalname;

        console.log(`Traitement de ${originalName}...`);

        const tasks = [];

        // Tâche 1 : Images AVIF (Priorité absolue)
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
                    .then(buffer => ({
                        type: 'image',
                        size: size.name,
                        data: buffer.toString('base64')
                    }))
                    .catch(err => {
                        console.error(`Erreur Sharp (${size.name}):`, err);
                        return null;
                    })
            );
        });

        // Tâche 2 : IA Gemini 2.5 Flash (Mise à jour)
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    // MISE À JOUR ICI : On utilise le modèle 2.5 Flash
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
                    const prompt = "Expert SEO. Analyse cette image pour le web. Retourne un JSON valide : { 'title': '...', 'alt': '...', 'description': '...' }. Langue : Français.";
                    
                    const result = await model.generateContent([
                        prompt,
                        { inlineData: { data: inputBuffer.toString('base64'), mimeType: mimeType } }
                    ]);
                    
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    return { type: 'seo', data: JSON.parse(text) };
                } catch (err) {
                    console.error("⚠️ Erreur IA (Ignorée pour sauver l'image):", err.message);
                    return { type: 'seo', data: null };
                }
            })());
        }

        // ATTENTE DES RÉSULTATS
        const results = await Promise.all(tasks);

        const responseData = { images: {}, seo: null };

        results.forEach(item => {
            if (!item) return;
            if (item.type === 'image') {
                responseData.images[item.size] = item.data;
            } else if (item.type === 'seo' && item.data) {
                responseData.seo = item.data;
            }
        });

        res.json(responseData);

    } catch (error) {
        console.error("Erreur Critique Usine:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Usine démarrée sur le port ${PORT}`));
