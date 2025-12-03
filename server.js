const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// On accepte des images jusqu'à 10Mo
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 10 * 1024 * 1024 } 
});

app.use(express.json({ limit: '50mb' }));

// RÉCUPÉRATION DES CLÉS (Réglées dans Render plus tard)
const API_KEY_GEMINI = process.env.GEMINI_API_KEY; 
const SECRET_TOKEN = process.env.MY_SECRET_TOKEN;

app.get('/', (req, res) => res.send('Usine à Images Prête 🚀'));

app.post('/process', upload.single('image'), async (req, res) => {
    // 1. SÉCURITÉ : On vérifie le mot de passe
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
        return res.status(403).json({ error: 'Accès refusé. Mauvais token.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Pas d\'image reçue.' });

    try {
        const inputBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;

        console.log(`Traitement de ${req.file.originalname}...`);

        const tasks = [];

        // 2. TRAITEMENT IMAGE (Sharp) : 4 tailles
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
                    .toFormat('avif', { quality: 60, effort: 4 })
                    .toBuffer()
                    .then(buffer => ({
                        type: 'image',
                        size: size.name,
                        data: buffer.toString('base64')
                    }))
            );
        });

        // 3. TRAITEMENT IA (Gemini) : SEO
        if (API_KEY_GEMINI) {
            tasks.push((async () => {
                const genAI = new GoogleGenerativeAI(API_KEY_GEMINI);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                
                const prompt = "Expert SEO. Analyse cette image. Retourne UNIQUEMENT un objet JSON valide (sans balises markdown) avec 3 clés : 'title' (titre court), 'alt' (description accessibilité), 'description' (2 phrases engageantes). Réponds en Français.";
                
                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: inputBuffer.toString('base64'), mimeType: mimeType } }
                ]);
                
                let text = result.response.text();
                // Nettoyage au cas où Gemini ajoute du markdown
                text = text.replace(/```json|```/g, '').trim();
                return { type: 'seo', data: JSON.parse(text) };
            })());
        }

        // 4. ATTENTE ET RÉPONSE
        const results = await Promise.all(tasks);

        const responseData = { images: {}, seo: null };

        results.forEach(item => {
            if (item.type === 'image') {
                responseData.images[item.size] = item.data;
            } else if (item.type === 'seo') {
                responseData.seo = item.data;
            }
        });

        res.json(responseData);

    } catch (error) {
        console.error("Erreur Usine:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Usine démarrée sur le port ${PORT}`));
