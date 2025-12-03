const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// Configuration de l'upload (20 Mo max)
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 20 * 1024 * 1024 } 
});

// Récupération des variables d'environnement
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

app.get('/', (req, res) => res.send('Usine OK (Stable)'));

// Route principale de traitement
app.post('/process', (req, res, next) => {
    // 0. MOUCHARD : On logue l'arrivée de la requête
    console.log("📨 REQUÊTE REÇUE !");
    next();
}, upload.single('image'), async (req, res) => {
    
    // 1. SÉCURITÉ : Vérification du Token
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        console.error("⛔ Refusé : Mauvais token.");
        return res.status(403).json({ error: 'Accès refusé. Mauvais token.' });
    }

    // 2. VÉRIFICATION FICHIER
    if (!req.file) {
        console.error("⛔ Refusé : Pas de fichier image.");
        return res.status(400).json({ error: 'Pas de fichier image reçu.' });
    }

    try {
        console.log(`✅ Image acceptée : ${req.file.originalname} (${req.file.size} bytes)`);
        
        const inputBuffer = req.file.buffer;
        const tasks = [];

        // --- TÂCHE A : CONVERSION AVIF (4 Tailles) ---
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
                    .catch(err => { 
                        console.error(`Erreur Sharp ${size.name}:`, err); 
                        return null; 
                    })
            );
        });

        // --- TÂCHE B : IA GEMINI (Modèle 1.5 Flash - Compatible & Stable) ---
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    
                    // ON UTILISE LA VERSION 1.5 POUR ÉVITER L'ERREUR "FETCH FAILED"
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    
                    const prompt = "Expert SEO. Analyse cette image. Retourne UNIQUEMENT un JSON valide : { 'title': '...', 'alt': '...', 'description': '...' }. Langue : Français.";
                    
                    const result = await model.generateContent([
                        prompt,
                        { inlineData: { data: inputBuffer.toString('base64'), mimeType: req.file.mimetype } }
                    ]);
                    
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    return { type: 'seo', data: JSON.parse(text) };

                } catch (err) {
                    console.error("⚠️ L'IA a échoué (Ignoré pour sauver l'image):", err.message);
                    return { type: 'seo', data: null }; // On ne plante pas, on renvoie null
                }
            })());
        }

        // 3. ATTENTE ET RÉPONSE
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Usine démarrée sur le port ${PORT}`));
