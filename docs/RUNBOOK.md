# Ishga tushirish — birinchi marta

Bu hujjat butun tizimni bir mashinada ko'tarish ketma-ketligi. U taxmin asosida emas: har bir
qadam shu repozitoriyada bajarib ko'rilgan, va yo'l-yo'lakay uchta haqiqiy to'siq topilib
tuzatilgan (`docs/CHANGELOG.md`, 2026-07-25).

Nima **tekshirilgan** va nima **hali tekshirilmagan** — oxirgi bo'limda ochiq yozilgan.

## Kerakli narsalar

| | Versiya | Nima uchun |
|---|---|---|
| Node | 22+ | `package.json` `engines` shuni talab qiladi |
| pnpm | 9.12.0 | `packageManager` maydonida qadalgan |
| Docker | Compose bilan | Mongo replica set, Redis, Typesense, MinIO, ClamAV |

Docker **majburiy**, ixtiyoriy emas. Har bir pul yo'li ko'p hujjatli tranzaksiya, ular esa
yakka `mongod` da umuman ishlamaydi (ADR-0001). Compose fayli shuning uchun replica set
ko'taradi.

---

## 1. Bog'liqliklar

```bash
pnpm install
pnpm build
```

`build` birinchi bo'lishi shart: `apps/api` ishlab turgan paytda `packages/*` ning
kompilyatsiya qilingan `dist` fayllarini o'qiydi.

## 2. Infratuzilma

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Beshta xizmat ko'tariladi. `mongo-init` konteyneri replica set'ni bir marta ishga tushiradi va
o'chadi — bu normal.

**ClamAV birinchi ishga tushishda imzo bazasini yuklaydi va bu bir necha daqiqa oladi.** U
tayyor bo'lmaguncha API fayl yuklashni rad etadi — bu ataylab: skanerlanmagan faylni qabul
qilgandan ko'ra rad etish yaxshiroq. Faqat katalog va buyurtmalarni sinayotgan bo'lsangiz,
kutish shart emas.

Holatni tekshirish:

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

## 3. Muhit va imzo kalitlari

```bash
cd apps/api
cp .env.example .env
```

`.env` da to'ldirilishi kerak bo'lganlar:

```
MONGODB_URI=mongodb://localhost:27017/bozorlar?replicaSet=rs0&directConnection=true
MONGODB_DB_NAME=bozorlar
REDIS_URL=redis://localhost:6379
JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem
JWT_PUBLIC_KEY_PATH=./keys/jwt-public.pem
PII_ENCRYPTION_KEY=<base64, 32 bayt>
TYPESENSE_API_KEY=dev-typesense-key
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002
```

`CORS_ORIGINS` uchta portni ham o'z ichiga olishi shart — web 3000, sotuvchi 3001, admin 3002.
Bittasi tushib qolsa, o'sha ilova brauzerda jimgina ishlamaydi.

Keyin kalitlar:

```bash
pnpm keys:generate
```

Kalitlar `.gitignore` da va shunday qolishi kerak.

## 4. Migratsiyalar va boshlang'ich ma'lumot

```bash
pnpm migrate:up
pnpm seed
```

Migratsiyalar kolleksiyalarni `$jsonSchema` validatorlari va indekslari bilan yaratadi. `seed`
viloyatlar, tumanlar va kategoriya daraxtini yozadi.

**Bozorlar va do'konlar seed qilinmaydi** — ular admin panel orqali qo'shiladi (`/malumotnoma`).

## 5. Komissiya qoidasi — o'tkazib yubormang

Hozircha bitta ham qoida yo'q, ya'ni **har bir yakunlangan buyurtma `NO_APPLICABLE_RULE` bilan
yoziladi va platforma hech narsa olmaydi.**

Admin panelda `/komissiya` sahifasida platforma darajasidagi qoida kiriting. Buni birinchi
haqiqiy buyurtmadan **oldin** qilish kerak: qoida orqaga ishlamaydi.

## 6. Ishga tushirish

Har biri alohida terminalda:

```bash
pnpm --filter @bozorlar/api dev        # :4000
pnpm --filter @bozorlar/worker dev     # fon vazifalari
pnpm --filter @bozorlar/web dev        # :3000
pnpm --filter @bozorlar/seller dev     # :3001
pnpm --filter @bozorlar/admin dev      # :3002
```

Worker ixtiyoriy emas: outbox hodisalarini u yetkazadi. Usiz qidiruv indeksi yangilanmaydi,
bildirishnomalar ketmaydi, muddati o'tgan buyurtmalar yopilmaydi va sevimlilar xabarnomalari
kelmaydi.

Frontend ilovalarga API manzili kerak — har birining papkasida `.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

## 7. Mobil ilova

```bash
pnpm --filter @bozorlar/mobile start
```

Muhit o'zgaruvchisi `EXPO_PUBLIC_API_URL`. **Haqiqiy telefon `localhost` ga yeta olmaydi** —
kompyuteringizning tarmoqdagi manzilini yozing, masalan `http://192.168.1.5:4000`.

---

## Nima tekshirilgan, nima yo'q

**Tekshirilgan** — shu repozitoriyada bajarib ko'rilgan:

- `pnpm install`, `pnpm build` — 21/21 vazifa
- `pnpm typecheck` — 36/36, `pnpm test` — 349 test
- API muhitni yuklaydi, JWT kalitlarini o'qiydi, loggerni yaratadi va Mongo'ga ulanishga
  urinadi — ya'ni **infratuzilmagacha bo'lgan butun yo'l ishlaydi**
- `pnpm keys:generate` kalit juftini yozadi
- `tsx` dev rejimi `.js` import'larini to'g'ri yechadi

**Tekshirilmagan** — bu muhitda Docker yo'q:

- Migratsiyalar haqiqiy Mongo'ga qo'llanilmagan
- Seed ishga tushirilmagan
- Birorta HTTP so'rov haqiqiy API'ga yuborilmagan
- To'rtala frontend ham **hech qachon jonli API bilan ishlatilmagan** — ~90 sahifa va ekran
- Integration testlar CI'da hech qachon o'tmagan
- Mobil ilova hech qachon bundle qilinmagan; Metro monorepo sozlamasi mulohaza asosida

Birinchi ishga tushirishda kutilishi mumkin bo'lgan muammolar aynan shu ro'yxatdan chiqadi:
CORS, bo'sh baza, Metro symlink'lari, va integration harness.

## Uchrashi mumkin bo'lgan xatolar

**`unable to determine transport target for "pino-pretty"`** — tuzatilgan (`@bozorlar/logger`
ga bog'liqlik qo'shildi). Agar chiqsa, `pnpm install` qayta ishga tushiring.

**`ENOENT ./keys/jwt-private.pem`** — 3-qadam bajarilmagan.

**`MONGODB_URI must point at a replica set`** — URI'da `replicaSet=rs0` yo'q. Bu qo'riqchi
ataylab qattiq: yakka `mongod` da birinchi komissiya yozuvi commit bo'lmaydi.

**`MongooseServerSelectionError: ECONNREFUSED 127.0.0.1:27017`** — Mongo ko'tarilmagan yoki
replica set ishga tushmagan. `docker compose ... logs mongo-init` ni ko'ring.

**Brauzerda so'rovlar jimgina yiqiladi** — `CORS_ORIGINS` da o'sha port yo'q.

**Buyurtma yakunlandi, lekin komissiya olinmadi** — 5-qadam o'tkazib yuborilgan. Admin
panelning bosh sahifasi buni aniq ogohlantirish bilan ko'rsatadi.
