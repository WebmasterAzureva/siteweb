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

app.get('/', (req, res) => res.send('Usine OK (V6 - Gemini 2.5 Flash)'));

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

        // --- TÂCHE B : IA GEMINI (avec image compressée pour éviter le "fetch failed") ---
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    // 🆕 Modèle mis à jour (1.5 retiré par Google en 2024)
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
                    // 🆕 COMPRESSION DE L'IMAGE AVANT ENVOI À GEMINI
                    // Évite le "fetch failed" sur les grosses images
                    const compressedBuffer = await sharp(inputBuffer)
                        .resize({ width: 800, withoutEnlargement: true })
                        .jpeg({ quality: 70 })
                        .toBuffer();
                    
                    console.log(`🤖 Envoi à Gemini : ${(compressedBuffer.length / 1024).toFixed(0)} Ko (compressé)`);
                    
                    const prompt = "Expert SEO. Analyse cette image. Retourne UNIQUEMENT un JSON valide : { 'title': '...', 'alt': '...', 'description': '...' }. Langue : Français.";
                    
                    const result = await model.generateContent([
                        prompt,
                        { 
                            inlineData: { 
                                data: compressedBuffer.toString('base64'),
                                mimeType: 'image/jpeg'
                            } 
                        }
                    ]);
                    
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    console.log("✅ Gemini a répondu !");
                    return { type: 'seo', data: JSON.parse(text) };

                } catch (err) {
                    console.error("⚠️ L'IA a échoué (Ignoré pour sauver l'image):", err.message);
                    return { type: 'seo', data: null };
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
app.listen(PORT, () => console.log(`🏭 Usine V6 (Gemini 2.5) démarrée sur le port ${PORT}`));
