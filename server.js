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

// Variables d'environnement
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

// Qualités par défaut
const DEFAULT_QUALITIES = {
    mobile: 50,
    tablet: 55,
    desktop: 60,
    large: 70
};

app.get('/', (req, res) => res.send('🏭 Usine V7 - Qualités AVIF configurables'));

// Route principale
app.post('/process', (req, res, next) => {
    console.log("📨 REQUÊTE REÇUE !");
    next();
}, upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'qualities', maxCount: 1 }
]), async (req, res) => {
    
    // 1. SÉCURITÉ
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        console.error("⛔ Refusé : Mauvais token.");
        return res.status(403).json({ error: 'Accès refusé.' });
    }

    // 2. VÉRIFICATION FICHIER
    if (!req.files || !req.files.image || !req.files.image[0]) {
        console.error("⛔ Refusé : Pas de fichier image.");
        return res.status(400).json({ error: 'Pas de fichier image.' });
    }

    try {
        const imageFile = req.files.image[0];
        console.log(`✅ Image : ${imageFile.originalname} (${imageFile.size} bytes)`);
        
        // 3. RÉCUPÉRER LES QUALITÉS (depuis le formulaire ou défaut)
        let qualities = { ...DEFAULT_QUALITIES };
        
        if (req.body && req.body.qualities) {
            try {
                const customQualities = JSON.parse(req.body.qualities);
                qualities = {
                    mobile: parseInt(customQualities.mobile) || DEFAULT_QUALITIES.mobile,
                    tablet: parseInt(customQualities.tablet) || DEFAULT_QUALITIES.tablet,
                    desktop: parseInt(customQualities.desktop) || DEFAULT_QUALITIES.desktop,
                    large: parseInt(customQualities.large) || DEFAULT_QUALITIES.large
                };
                console.log(`🎚️ Qualités personnalisées :`, qualities);
            } catch (e) {
                console.log(`⚠️ Qualités invalides, utilisation des défauts`);
            }
        } else {
            console.log(`🎚️ Qualités par défaut :`, qualities);
        }
        
        const inputBuffer = imageFile.buffer;
        const tasks = [];

        // --- TÂCHE A : CONVERSION AVIF (4 Tailles avec qualités différentes) ---
        const sizes = [
            { name: 'mobile', width: 480, quality: qualities.mobile },
            { name: 'tablet', width: 768, quality: qualities.tablet },
            { name: 'desktop', width: 1280, quality: qualities.desktop },
            { name: 'large', width: 1920, quality: qualities.large }
        ];

        sizes.forEach(size => {
            tasks.push(
                sharp(inputBuffer)
                    .resize({ width: size.width, withoutEnlargement: true })
                    .toFormat('avif', { 
                        quality: size.quality, 
                        effort: 4  // Un peu plus d'effort pour meilleure compression
                    })
                    .toBuffer()
                    .then(buffer => {
                        const sizeKo = (buffer.length / 1024).toFixed(1);
                        console.log(`   📦 ${size.name}: ${size.width}px @ Q${size.quality} → ${sizeKo} Ko`);
                        return { type: 'image', size: size.name, data: buffer.toString('base64') };
                    })
                    .catch(err => { 
                        console.error(`❌ Erreur Sharp ${size.name}:`, err.message); 
                        return null; 
                    })
            );
        });

        // --- TÂCHE B : IA GEMINI ---
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                try {
                    const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
                    // Compression pour Gemini
                    const compressedBuffer = await sharp(inputBuffer)
                        .resize({ width: 800, withoutEnlargement: true })
                        .jpeg({ quality: 70 })
                        .toBuffer();
                    
                    console.log(`🤖 Envoi à Gemini : ${(compressedBuffer.length / 1024).toFixed(0)} Ko`);
                    
                    const prompt = "Expert SEO. Analyse cette image. Retourne UNIQUEMENT un JSON valide : { 'title': '...', 'alt': '...', 'description': '...' }. Langue : Français.";
                    
                    const result = await model.generateContent([
                        prompt,
                        { inlineData: { data: compressedBuffer.toString('base64'), mimeType: 'image/jpeg' } }
                    ]);
                    
                    const text = result.response.text().replace(/```json|```/g, '').trim();
                    console.log("✅ Gemini OK");
                    return { type: 'seo', data: JSON.parse(text) };

                } catch (err) {
                    console.error("⚠️ Gemini échoué:", err.message);
                    return { type: 'seo', data: null };
                }
            })());
        }

        // 4. ATTENTE ET RÉPONSE
        const results = await Promise.all(tasks);
        const responseData = { images: {}, seo: null };

        results.forEach(item => {
            if (!item) return;
            if (item.type === 'image') responseData.images[item.size] = item.data;
            if (item.type === 'seo') responseData.seo = item.data;
        });

        console.log(`✅ Terminé : ${Object.keys(responseData.images).length} AVIF générés\n`);
        res.json(responseData);

    } catch (error) {
        console.error("❌ Erreur:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏭 Usine V7 démarrée sur le port ${PORT}`));
