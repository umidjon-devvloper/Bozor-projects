import type { LocalizedText } from '@bozorlar/types';
import { Channel, NotificationCategory } from './constants.js';

/**
 * Notification copy, in the four locales the platform serves.
 *
 * This is product copy, not configuration: it ships with the code because a wording change is
 * a code review, and because a template that can be edited in a database can be edited into
 * something that reads like a phishing message. Placeholders are `{{name}}` and every one is
 * required — rendering `{{orderNo}}` to a seller is worse than failing to send.
 */
export interface NotificationTemplate {
  type: string;
  category: NotificationCategory;
  channels: readonly Channel[];
  title: LocalizedText;
  body: LocalizedText;
  /** Placeholders that must be supplied. Missing ones are an error, not an empty string. */
  variables: readonly string[];
  targetType: string | null;
}

export const TEMPLATES: readonly NotificationTemplate[] = [
  {
    type: 'order.created',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Yangi buyurtma',
      uzCyrl: 'Янги буюртма',
      ru: 'Новый заказ',
      en: 'New order',
    },
    body: {
      uz: '{{buyerName}} sizga {{total}} soʻmlik buyurtma berdi. {{minutes}} daqiqa ichida javob bering.',
      uzCyrl: '{{buyerName}} сизга {{total}} сўмлик буюртма берди. {{minutes}} дақиқа ичида жавоб беринг.',
      ru: '{{buyerName}} оформил заказ на {{total}} сум. Ответьте в течение {{minutes}} минут.',
      en: '{{buyerName}} placed an order for {{total}} UZS. Please respond within {{minutes}} minutes.',
    },
    variables: ['buyerName', 'total', 'minutes'],
    targetType: 'order',
  },
  {
    type: 'order.accepted',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Buyurtmangiz qabul qilindi',
      uzCyrl: 'Буюртмангиз қабул қилинди',
      ru: 'Заказ принят',
      en: 'Order accepted',
    },
    body: {
      uz: '{{shopName}} buyurtmangizni qabul qildi. Tayyor boʻlgach xabar beramiz.',
      uzCyrl: '{{shopName}} буюртмангизни қабул қилди. Тайёр бўлгач хабар берамиз.',
      ru: '{{shopName}} принял ваш заказ. Мы сообщим, когда он будет готов.',
      en: '{{shopName}} accepted your order. We will let you know when it is ready.',
    },
    variables: ['shopName'],
    targetType: 'order',
  },
  {
    type: 'order.rejected',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Buyurtma bekor qilindi',
      uzCyrl: 'Буюртма бекор қилинди',
      ru: 'Заказ отклонён',
      en: 'Order declined',
    },
    body: {
      uz: '{{shopName}} buyurtmangizni bajara olmadi: {{reason}}',
      uzCyrl: '{{shopName}} буюртмангизни бажара олмади: {{reason}}',
      ru: '{{shopName}} не смог выполнить ваш заказ: {{reason}}',
      en: '{{shopName}} could not fulfil your order: {{reason}}',
    },
    variables: ['shopName', 'reason'],
    targetType: 'order',
  },
  {
    type: 'order.ready_for_pickup',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Buyurtmangiz tayyor',
      uzCyrl: 'Буюртмангиз тайёр',
      ru: 'Заказ готов',
      en: 'Your order is ready',
    },
    body: {
      // The stall reference matters more than anything else here: a bazaar is a maze.
      uz: '{{shopName}} ({{stall}}) buyurtmangizni tayyorladi. Olib ketish kodi ilovada.',
      uzCyrl: '{{shopName}} ({{stall}}) буюртмангизни тайёрлади. Олиб кетиш коди иловада.',
      ru: '{{shopName}} ({{stall}}) подготовил ваш заказ. Код получения — в приложении.',
      en: '{{shopName}} ({{stall}}) has your order ready. Your pickup code is in the app.',
    },
    variables: ['shopName', 'stall'],
    targetType: 'order',
  },
  {
    type: 'order.adjustment_requested',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Ogʻirlik oʻzgardi — tasdiqlang',
      uzCyrl: 'Оғирлик ўзгарди — тасдиқланг',
      ru: 'Вес изменился — подтвердите',
      en: 'Weight changed — please confirm',
    },
    body: {
      uz: 'Yangi summa {{newTotal}} soʻm (avval {{oldTotal}}). {{minutes}} daqiqa ichida tasdiqlang.',
      uzCyrl: 'Янги сумма {{newTotal}} сўм (аввал {{oldTotal}}). {{minutes}} дақиқа ичида тасдиқланг.',
      ru: 'Новая сумма {{newTotal}} сум (было {{oldTotal}}). Подтвердите в течение {{minutes}} минут.',
      en: 'New total {{newTotal}} UZS (was {{oldTotal}}). Please confirm within {{minutes}} minutes.',
    },
    variables: ['newTotal', 'oldTotal', 'minutes'],
    targetType: 'order',
  },
  {
    type: 'order.completed',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Buyurtma yakunlandi',
      uzCyrl: 'Буюртма якунланди',
      ru: 'Заказ завершён',
      en: 'Order complete',
    },
    body: {
      uz: '{{shopName}} bilan savdongiz yakunlandi. Baho qoldirasizmi?',
      uzCyrl: '{{shopName}} билан савдонгиз якунланди. Баҳо қолдирасизми?',
      ru: 'Ваш заказ у {{shopName}} завершён. Оставите отзыв?',
      en: 'Your order with {{shopName}} is complete. Would you leave a review?',
    },
    variables: ['shopName'],
    targetType: 'order',
  },
  {
    type: 'order.cancelled',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Buyurtma bekor qilindi',
      uzCyrl: 'Буюртма бекор қилинди',
      ru: 'Заказ отменён',
      en: 'Order cancelled',
    },
    body: {
      uz: '{{orderNo}} raqamli buyurtma bekor qilindi.',
      uzCyrl: '{{orderNo}} рақамли буюртма бекор қилинди.',
      ru: 'Заказ {{orderNo}} отменён.',
      en: 'Order {{orderNo}} has been cancelled.',
    },
    variables: ['orderNo'],
    targetType: 'order',
  },
  {
    type: 'order.expired',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Buyurtma muddati oʻtdi',
      uzCyrl: 'Буюртма муддати ўтди',
      ru: 'Время на ответ истекло',
      en: 'Order expired',
    },
    body: {
      uz: 'Sotuvchi {{orderNo}} buyurtmasiga vaqtida javob bermadi. Toʻlov olinmadi.',
      uzCyrl: 'Сотувчи {{orderNo}} буюртмасига вақтида жавоб бермади. Тўлов олинмади.',
      ru: 'Продавец не ответил на заказ {{orderNo}} вовремя. Оплата не взималась.',
      en: 'The seller did not respond to order {{orderNo}} in time. Nothing was charged.',
    },
    variables: ['orderNo'],
    targetType: 'order',
  },
  {
    type: 'wallet.low_balance',
    category: NotificationCategory.WALLET,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Hisobingiz tugayapti',
      uzCyrl: 'Ҳисобингиз тугаяпти',
      ru: 'Баланс заканчивается',
      en: 'Your balance is running low',
    },
    body: {
      uz: 'Balansingiz {{balance}} soʻm. Toʻldirmasangiz doʻkoningiz vaqtincha yopiladi.',
      uzCyrl: 'Балансингиз {{balance}} сўм. Тўлдирмасангиз дўконингиз вақтинча ёпилади.',
      ru: 'На балансе {{balance}} сум. Без пополнения магазин будет временно скрыт.',
      en: 'Your balance is {{balance}} UZS. Without a top-up your shop will be hidden.',
    },
    variables: ['balance'],
    targetType: 'wallet',
  },
  {
    type: 'seller.deactivated',
    category: NotificationCategory.WALLET,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Doʻkoningiz vaqtincha yopildi',
      uzCyrl: 'Дўконингиз вақтинча ёпилди',
      ru: 'Магазин временно скрыт',
      en: 'Your shop is hidden',
    },
    body: {
      uz: 'Hisobingizda mablagʻ qolmadi. Toʻldiring va doʻkoningiz darhol qayta ochiladi.',
      uzCyrl: 'Ҳисобингизда маблағ қолмади. Тўлдиринг ва дўконингиз дарҳол қайта очилади.',
      ru: 'На балансе не осталось средств. Пополните — магазин откроется сразу.',
      en: 'Your balance has run out. Top up and your shop reopens immediately.',
    },
    variables: [],
    targetType: 'wallet',
  },
  {
    type: 'seller.approved',
    category: NotificationCategory.MODERATION,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Arizangiz tasdiqlandi',
      uzCyrl: 'Аризангиз тасдиқланди',
      ru: 'Заявка одобрена',
      en: 'Application approved',
    },
    body: {
      uz: 'Tabriklaymiz! Endi doʻkon ochib, mahsulot joylashingiz mumkin.',
      uzCyrl: 'Табриклаймиз! Энди дўкон очиб, маҳсулот жойлашингиз мумкин.',
      ru: 'Поздравляем! Теперь вы можете открыть магазин и добавить товары.',
      en: 'Congratulations. You can now open your shop and list products.',
    },
    variables: [],
    targetType: 'seller_application',
  },
  {
    type: 'seller.rejected',
    category: NotificationCategory.MODERATION,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Ariza qaytarildi',
      uzCyrl: 'Ариза қайтарилди',
      ru: 'Заявка отклонена',
      en: 'Application returned',
    },
    body: {
      uz: 'Sabab: {{reason}}. Tuzatib, qayta yuborishingiz mumkin.',
      uzCyrl: 'Сабаб: {{reason}}. Тузатиб, қайта юборишингиз мумкин.',
      ru: 'Причина: {{reason}}. Исправьте и отправьте заявку снова.',
      en: 'Reason: {{reason}}. You can correct it and submit again.',
    },
    variables: ['reason'],
    targetType: 'seller_application',
  },
  {
    type: 'product.moderation_rejected',
    category: NotificationCategory.MODERATION,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Mahsulot qaytarildi',
      uzCyrl: 'Маҳсулот қайтарилди',
      ru: 'Товар отклонён',
      en: 'Product returned',
    },
    body: {
      uz: '{{productName}}: {{reason}}',
      uzCyrl: '{{productName}}: {{reason}}',
      ru: '{{productName}}: {{reason}}',
      en: '{{productName}}: {{reason}}',
    },
    variables: ['productName', 'reason'],
    targetType: 'product',
  },
  {
    type: 'review.created',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Yangi sharh',
      uzCyrl: 'Янги шарҳ',
      ru: 'Новый отзыв',
      en: 'New review',
    },
    body: {
      uz: '{{buyerName}} sizga {{rating}} yulduz qoldirdi. Javob berishingiz mumkin.',
      uzCyrl: '{{buyerName}} сизга {{rating}} юлдуз қолдирди. Жавоб беришингиз мумкин.',
      ru: '{{buyerName}} оставил отзыв на {{rating}} звёзд. Вы можете ответить.',
      en: '{{buyerName}} left you a {{rating}}-star review. You can reply.',
    },
    variables: ['buyerName', 'rating'],
    targetType: 'review',
  },
  {
    type: 'review.replied',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Sotuvchi javob berdi',
      uzCyrl: 'Сотувчи жавоб берди',
      ru: 'Продавец ответил',
      en: 'The seller replied',
    },
    body: {
      uz: '{{shopName}} sharhingizga javob qoldirdi.',
      uzCyrl: '{{shopName}} шарҳингизга жавоб қолдирди.',
      ru: '{{shopName}} ответил на ваш отзыв.',
      en: '{{shopName}} replied to your review.',
    },
    variables: ['shopName'],
    targetType: 'review',
  },
  {
    type: 'dispute.raised',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Buyurtma boʻyicha shikoyat',
      uzCyrl: 'Буюртма бўйича шикоят',
      ru: 'Спор по заказу',
      en: 'Order disputed',
    },
    body: {
      uz: '{{orderNo}} buyurtmasi boʻyicha shikoyat keldi. {{hours}} soat ichida javob bering.',
      uzCyrl: '{{orderNo}} буюртмаси бўйича шикоят келди. {{hours}} соат ичида жавоб беринг.',
      ru: 'По заказу {{orderNo}} открыт спор. Ответьте в течение {{hours}} часов.',
      en: 'A dispute was opened on order {{orderNo}}. Please respond within {{hours}} hours.',
    },
    variables: ['orderNo', 'hours'],
    targetType: 'dispute',
  },
  {
    type: 'dispute.resolved',
    category: NotificationCategory.ORDER,
    channels: [Channel.PUSH, Channel.IN_APP, Channel.SMS],
    title: {
      uz: 'Shikoyat hal qilindi',
      uzCyrl: 'Шикоят ҳал қилинди',
      ru: 'Спор разрешён',
      en: 'Dispute resolved',
    },
    body: {
      uz: '{{orderNo}} boʻyicha qaror: {{outcome}}. Batafsil ilovada.',
      uzCyrl: '{{orderNo}} бўйича қарор: {{outcome}}. Батафсил иловада.',
      ru: 'Решение по заказу {{orderNo}}: {{outcome}}. Подробности в приложении.',
      en: 'Decision on order {{orderNo}}: {{outcome}}. Details are in the app.',
    },
    variables: ['orderNo', 'outcome'],
    targetType: 'dispute',
  },
  {
    type: 'shop.moderation_approved',
    category: NotificationCategory.MODERATION,
    channels: [Channel.PUSH, Channel.IN_APP],
    title: {
      uz: 'Doʻkoningiz tasdiqlandi',
      uzCyrl: 'Дўконингиз тасдиқланди',
      ru: 'Магазин одобрен',
      en: 'Shop approved',
    },
    body: {
      uz: '{{shopName}} endi xaridorlarga koʻrinadi.',
      uzCyrl: '{{shopName}} энди харидорларга кўринади.',
      ru: '{{shopName}} теперь виден покупателям.',
      en: '{{shopName}} is now visible to buyers.',
    },
    variables: ['shopName'],
    targetType: 'shop',
  },
];

export const TEMPLATES_BY_TYPE: ReadonlyMap<string, NotificationTemplate> = new Map(
  TEMPLATES.map((template) => [template.type, template]),
);
