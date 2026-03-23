# 🔴 WANTED — Plateforme communautaire personnes disparues

> Ensemble, retrouvons-les. Signalez, partagez, récompensez.

---

## 📁 Structure du projet

```
wanted3/
├── backend/          → API Node.js + Express + PostgreSQL
│   ├── src/
│   │   ├── config/   → DB, migrations, emails, coins
│   │   ├── controllers/
│   │   ├── middleware/
│   │   └── routes/
│   ├── .env.example
│   └── package.json
└── frontend/         → Site HTML/CSS/JS pur (multi-pages)
    ├── index.html    → Accueil
    ├── css/main.css
    ├── js/
    │   ├── config.js → URL API à modifier ici
    │   └── api.js    → Client API partagé
    └── pages/
        ├── login.html
        ├── register.html
        ├── forgot-password.html
        ├── reset-password.html
        ├── feed.html
        ├── post-detail.html
        ├── profile.html
        ├── messages.html
        ├── admin.html
        └── payment-callback.html
```

---

## 🚀 DÉMARRAGE RAPIDE (local)

### 1. Prérequis
- Node.js 18+
- PostgreSQL 14+
- Un compte [Resend](https://resend.com) (gratuit : 3 000 emails/mois)
- Un compte [Fapshi](https://fapshi.com) (paiements Orange/MTN)

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
# Remplissez toutes les variables dans .env
npm run db:migrate
npm run dev
```

### 3. Frontend

Ouvrez `frontend/index.html` avec un serveur local (ex: Live Server VSCode).

Dans `frontend/js/config.js`, laissez :
```js
window.WANTED_API = 'http://localhost:5000/api';
```

---

## ☁️ DÉPLOIEMENT PRODUCTION

### Backend → Railway

1. Créer un projet sur [railway.app](https://railway.app)
2. Ajouter un service **PostgreSQL** → copiez `DATABASE_URL`
3. Ajouter un service **Node.js** → importer le dossier `backend/`
4. Configurer toutes les variables d'environnement (voir `.env.example`)
5. Railway détecte `railway.json` et lance `node src/server.js`
6. Copier l'URL de déploiement → ex: `https://wanted-api.railway.app`

### Frontend → Vercel

1. Installer Vercel CLI : `npm i -g vercel`
2. Dans `frontend/js/config.js`, remplacer l'URL :
   ```js
   window.WANTED_API = 'https://wanted-api.railway.app/api';
   ```
3. Déployer :
   ```bash
   cd frontend
   vercel --prod
   ```
4. Copier l'URL Vercel → ex: `https://wanted.vercel.app`

### Mettre à jour `FRONTEND_URL` dans les variables Railway
```
FRONTEND_URL=https://wanted.vercel.app
BACKEND_URL=https://wanted-api.railway.app
```

---

## ⚙️ VARIABLES D'ENVIRONNEMENT

| Variable | Description | Exemple |
|---|---|---|
| `DATABASE_URL` | URL PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Clé secrète JWT (64+ chars) | `changez_moi_...` |
| `RESEND_API_KEY` | Clé API Resend | `re_xxxx` |
| `RESEND_FROM` | Email expéditeur | `noreply@mondomaine.com` |
| `FAPSHI_API_USER` | Identifiant Fapshi | `mon_user` |
| `FAPSHI_API_KEY` | Clé API Fapshi | `ma_cle` |
| `FAPSHI_BASE_URL` | URL Fapshi | `https://live.fapshi.com` |
| `ADMIN_EMAIL` | Email du premier admin | `admin@email.com` |
| `FRONTEND_URL` | URL du frontend | `https://wanted.vercel.app` |
| `BACKEND_URL` | URL du backend (pour les webhooks) | `https://wanted-api.railway.app` |

---

## 👑 COMPTE ADMIN PAR DÉFAUT

Au **premier démarrage**, le serveur crée automatiquement un compte administrateur :

| Champ | Valeur par défaut |
|---|---|
| Email | `admin@wanted.app` |
| Mot de passe | `Admin@2024!` |

> ⚠️ **Changez ce mot de passe** dès la première connexion dans Profil → Paramètres → Changer le mot de passe.

Vous pouvez personnaliser ces valeurs dans `.env` :
```env
ADMIN_EMAIL=votre@email.com
ADMIN_PASSWORD=VotreMotDePasseSecurisé!
ADMIN_NAME=Votre Nom
```

---

## 🔧 PROBLÈME : "not valid JSON" / erreur de connexion

Cette erreur signifie que le frontend essaie de contacter un mauvais serveur.

**Cause :** `frontend/js/config.js` pointe sur `localhost:5000` mais le backend n'est pas démarré ou est sur une autre URL.

**Solution :**
1. Assurez-vous que le backend tourne (`npm run dev` dans `backend/`)
2. En production, modifiez **une seule ligne** dans `frontend/js/config.js` :
```js
const PRODUCTION_API_URL = 'https://votre-backend.railway.app/api';
```

---

## 🪙 SYSTÈME DE COINS (récompenses réelles)

| Action | Coins |
|---|---|
| Inscription | +100 |
| Publier un signalement | +20 |
| Repartager | +10 |
| Partager (externe) | +5 |
| Témoignage | +50 |
| Personne retrouvée | +200 |

**Taux de change :** 1 coin = 1 XAF (configurable dans admin)  
**Retrait minimum :** 500 coins → via Orange Money ou MTN Money (Fapshi)

### Badges automatiques
| Coins | Badge |
|---|---|
| 0 | Membre |
| 200+ | Engagé |
| 500+ | Actif |
| 1 000+ | Expert |
| 2 000+ | Héros |
| 5 000+ | Légende |

---

## 🔌 API — Endpoints principaux

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me
POST   /api/auth/forgot-password
POST   /api/auth/reset-password

GET    /api/posts              → Liste (filtres: status, urgency, search, userId)
POST   /api/posts              → Créer (multipart/form-data avec photo)
PUT    /api/posts/:id          → Modifier
DELETE /api/posts/:id          → Supprimer
POST   /api/posts/:id/like     → Like / Unlike
POST   /api/posts/:id/repost   → Repartager (avec remontée à l'original)
POST   /api/posts/:id/share    → Partage externe
POST   /api/posts/:id/found    → Marquer retrouvé + distribuer coins

GET    /api/users/me/coins     → Historique coins
PUT    /api/users/me           → Modifier profil
GET    /api/users/:id          → Profil public
GET    /api/users/:id/posts    → Publications/repartages d'un user

GET    /api/messages/conversations
GET    /api/messages/:userId
POST   /api/messages

GET    /api/notifications
PUT    /api/notifications/read-all

POST   /api/payments/initiate  → Démarrer un paiement Fapshi
POST   /api/payments/webhook   → Webhook Fapshi (reçoit confirmation)
GET    /api/payments/status/:txId
POST   /api/payments/withdraw  → Retrait vers Mobile Money
GET    /api/payments/history

GET    /api/settings
PUT    /api/settings           → (admin) Modifier config
GET    /api/settings/admin/stats → Statistiques admin
```

---

## 📱 FONCTIONNALITÉS

- ✅ Authentification JWT (register, login, forgot/reset password)
- ✅ Signalements avec photo, urgence (normal/urgent/critique), statut
- ✅ Repartage avec remontée à la publication originale
- ✅ Partage vers toutes les apps (Web Share API + clipboard)
- ✅ Marquer retrouvé → distribue les coins automatiquement
- ✅ Système de coins réels → retrait via Orange/MTN (Fapshi)
- ✅ Récompenses en Mobile Money sur les publications
- ✅ Messagerie directe entre utilisateurs
- ✅ Profil public cliquable avec publications et repartages
- ✅ Notifications en temps quasi-réel
- ✅ Dashboard admin (users, signalements, paiements, config)
- ✅ Design responsive mobile-first (mobile, tablette, desktop)
- ✅ PWA-ready (peut s'installer sur mobile)

---

## 🛠️ MODE DÉVELOPPEMENT

En mode `NODE_ENV=development` :
- Les paiements Fapshi sont **simulés** (pas de vraie transaction)
- Les emails Resend ne sont pas envoyés (logs console)
- Les coins sont crédités immédiatement

---

*WANTED v3.0 — Plateforme communautaire personnes disparues*
