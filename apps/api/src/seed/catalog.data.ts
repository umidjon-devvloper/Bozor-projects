import type { LocalizedText } from '@bozorlar/types';

/**
 * Units of sale and the category tree, as actually used in Uzbek bazaars.
 *
 * `decimalPlaces: 0` marks countable goods, where a fractional order is meaningless, and
 * `allowsAdjustment` marks goods weighed at handover, which is what activates the quantity
 * adjustment flow (ADR-0006). Getting these two flags wrong is the difference between "2.5 kg
 * of beef, actually 2.38" working and the order system rejecting reality.
 */
export interface SeedUnit {
  code: string;
  name: LocalizedText;
  shortName: LocalizedText;
  decimalPlaces: number;
  allowsAdjustment: boolean;
}

export const SEED_UNITS: SeedUnit[] = [
  {
    code: 'kg',
    name: { uz: 'kilogramm', uzCyrl: 'килограмм', ru: 'килограмм', en: 'kilogram' },
    shortName: { uz: 'kg', uzCyrl: 'кг', ru: 'кг', en: 'kg' },
    decimalPlaces: 3,
    allowsAdjustment: true,
  },
  {
    code: 'g',
    name: { uz: 'gramm', uzCyrl: 'грамм', ru: 'грамм', en: 'gram' },
    shortName: { uz: 'g', uzCyrl: 'г', ru: 'г', en: 'g' },
    decimalPlaces: 0,
    allowsAdjustment: true,
  },
  {
    code: 'dona',
    name: { uz: 'dona', uzCyrl: 'дона', ru: 'штука', en: 'piece' },
    shortName: { uz: 'dona', uzCyrl: 'дона', ru: 'шт', en: 'pc' },
    decimalPlaces: 0,
    allowsAdjustment: false,
  },
  {
    code: 'bogh',
    name: { uz: "bogʻ", uzCyrl: 'боғ', ru: 'пучок', en: 'bunch' },
    shortName: { uz: "bogʻ", uzCyrl: 'боғ', ru: 'пуч', en: 'bunch' },
    decimalPlaces: 0,
    allowsAdjustment: false,
  },
  {
    code: 'quti',
    name: { uz: 'quti', uzCyrl: 'қути', ru: 'коробка', en: 'box' },
    shortName: { uz: 'quti', uzCyrl: 'қути', ru: 'кор', en: 'box' },
    decimalPlaces: 0,
    allowsAdjustment: false,
  },
  {
    code: 'qop',
    name: { uz: 'qop', uzCyrl: 'қоп', ru: 'мешок', en: 'sack' },
    shortName: { uz: 'qop', uzCyrl: 'қоп', ru: 'меш', en: 'sack' },
    decimalPlaces: 0,
    allowsAdjustment: true,
  },
  {
    code: 'litr',
    name: { uz: 'litr', uzCyrl: 'литр', ru: 'литр', en: 'litre' },
    shortName: { uz: 'l', uzCyrl: 'л', ru: 'л', en: 'l' },
    decimalPlaces: 3,
    allowsAdjustment: true,
  },
  {
    code: 'metr',
    name: { uz: 'metr', uzCyrl: 'метр', ru: 'метр', en: 'metre' },
    shortName: { uz: 'm', uzCyrl: 'м', ru: 'м', en: 'm' },
    decimalPlaces: 2,
    allowsAdjustment: true,
  },
  {
    code: 'juft',
    name: { uz: 'juft', uzCyrl: 'жуфт', ru: 'пара', en: 'pair' },
    shortName: { uz: 'juft', uzCyrl: 'жуфт', ru: 'пара', en: 'pair' },
    decimalPlaces: 0,
    allowsAdjustment: false,
  },
];

export interface SeedAttribute {
  key: string;
  type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'ENUM';
  name: LocalizedText;
  options?: string[];
  required?: boolean;
  order?: number;
}

export interface SeedCategory {
  slug: string;
  name: LocalizedText;
  defaultUnit: string;
  allowedUnits: string[];
  /** Basis points. Weighed goods need real headroom; counted goods need none. */
  defaultTolerancePercent?: number;
  icon?: string;
  attributes?: SeedAttribute[];
  children?: SeedCategory[];
}

const ORIGIN: SeedAttribute = {
  key: 'origin',
  type: 'STRING',
  name: { uz: 'Yetishtirilgan joyi', uzCyrl: 'Етиштирилган жойи', ru: 'Происхождение', en: 'Origin' },
  order: 0,
};

const GRADE: SeedAttribute = {
  key: 'grade',
  type: 'ENUM',
  name: { uz: 'Navi', uzCyrl: 'Нави', ru: 'Сорт', en: 'Grade' },
  options: ['oliy', '1', '2'],
  order: 1,
};

const WEIGHED = ['kg', 'g', 'qop'];

export const SEED_CATEGORIES: SeedCategory[] = [
  {
    slug: 'oziq-ovqat',
    name: { uz: 'Oziq-ovqat', uzCyrl: 'Озиқ-овқат', ru: 'Продукты питания', en: 'Food' },
    defaultUnit: 'kg',
    allowedUnits: [...WEIGHED, 'dona', 'bogh', 'quti', 'litr'],
    defaultTolerancePercent: 1000,
    icon: 'basket',
    attributes: [ORIGIN],
    children: [
      {
        slug: 'sabzavotlar',
        name: { uz: 'Sabzavotlar', uzCyrl: 'Сабзавотлар', ru: 'Овощи', en: 'Vegetables' },
        defaultUnit: 'kg',
        allowedUnits: [...WEIGHED, 'dona', 'bogh'],
        attributes: [GRADE],
      },
      {
        slug: 'mevalar',
        name: { uz: 'Mevalar', uzCyrl: 'Мевалар', ru: 'Фрукты', en: 'Fruits' },
        defaultUnit: 'kg',
        allowedUnits: [...WEIGHED, 'dona', 'quti'],
        attributes: [GRADE],
      },
      {
        slug: 'kokatlar',
        name: { uz: "Koʻkatlar", uzCyrl: 'Кўкатлар', ru: 'Зелень', en: 'Herbs & greens' },
        defaultUnit: 'bogh',
        allowedUnits: ['bogh', 'kg', 'g'],
        // Herbs are sold in bunches; a bunch is a bunch, so no handover tolerance.
        defaultTolerancePercent: 0,
      },
      {
        slug: 'gosht',
        name: { uz: "Goʻsht", uzCyrl: 'Гўшт', ru: 'Мясо', en: 'Meat' },
        defaultUnit: 'kg',
        allowedUnits: ['kg', 'g'],
        // Meat is cut to order, so the delivered weight varies most of anything here.
        defaultTolerancePercent: 1500,
        attributes: [
          {
            key: 'meat_type',
            type: 'ENUM',
            name: { uz: 'Turi', uzCyrl: 'Тури', ru: 'Вид', en: 'Type' },
            options: ['mol', "qoʻy", 'tovuq', 'ot', 'echki'],
            required: true,
            order: 1,
          },
          {
            key: 'cut',
            type: 'STRING',
            name: { uz: 'Qismi', uzCyrl: 'Қисми', ru: 'Отруб', en: 'Cut' },
            order: 2,
          },
        ],
      },
      {
        slug: 'baliq',
        name: { uz: 'Baliq', uzCyrl: 'Балиқ', ru: 'Рыба', en: 'Fish' },
        defaultUnit: 'kg',
        allowedUnits: ['kg', 'g', 'dona'],
        defaultTolerancePercent: 1500,
      },
      {
        slug: 'sut-mahsulotlari',
        name: { uz: 'Sut mahsulotlari', uzCyrl: 'Сут маҳсулотлари', ru: 'Молочные продукты', en: 'Dairy' },
        defaultUnit: 'litr',
        allowedUnits: ['litr', 'kg', 'g', 'dona'],
      },
      {
        slug: 'tuxum',
        name: { uz: 'Tuxum', uzCyrl: 'Тухум', ru: 'Яйца', en: 'Eggs' },
        defaultUnit: 'dona',
        allowedUnits: ['dona', 'quti'],
        defaultTolerancePercent: 0,
      },
      {
        slug: 'non-va-nonvoyxona',
        name: { uz: 'Non va nonvoyxona', uzCyrl: 'Нон ва нонвойхона', ru: 'Хлеб и выпечка', en: 'Bread & bakery' },
        defaultUnit: 'dona',
        allowedUnits: ['dona', 'kg'],
        defaultTolerancePercent: 0,
      },
      {
        slug: 'yorma-va-dukkaklilar',
        name: { uz: 'Yorma va dukkaklilar', uzCyrl: 'Ёрма ва дуккаклилар', ru: 'Крупы и бобовые', en: 'Grains & legumes' },
        defaultUnit: 'kg',
        allowedUnits: [...WEIGHED],
        attributes: [GRADE],
      },
      {
        slug: 'quruq-mevalar-va-yongoqlar',
        name: { uz: "Quruq mevalar va yongʻoqlar", uzCyrl: 'Қуруқ мевалар ва ёнғоқлар', ru: 'Сухофрукты и орехи', en: 'Dried fruits & nuts' },
        defaultUnit: 'kg',
        allowedUnits: ['kg', 'g'],
        attributes: [GRADE],
      },
      {
        slug: 'ziravorlar',
        name: { uz: 'Ziravorlar', uzCyrl: 'Зираворлар', ru: 'Специи', en: 'Spices' },
        defaultUnit: 'g',
        allowedUnits: ['g', 'kg'],
      },
      {
        slug: 'asal-va-murabbolar',
        name: { uz: 'Asal va murabbolar', uzCyrl: 'Асал ва мурабболар', ru: 'Мёд и варенья', en: 'Honey & preserves' },
        defaultUnit: 'kg',
        allowedUnits: ['kg', 'g', 'litr', 'dona'],
      },
      {
        slug: 'yog-va-moy',
        name: { uz: "Yogʻ va moy", uzCyrl: 'Ёғ ва мой', ru: 'Масла и жиры', en: 'Oils & fats' },
        defaultUnit: 'litr',
        allowedUnits: ['litr', 'kg', 'dona'],
      },
    ],
  },
  {
    slug: 'kiyim-kechak',
    name: { uz: 'Kiyim-kechak', uzCyrl: 'Кийим-кечак', ru: 'Одежда', en: 'Clothing' },
    defaultUnit: 'dona',
    allowedUnits: ['dona', 'juft', 'metr'],
    defaultTolerancePercent: 0,
    icon: 'shirt',
    attributes: [
      {
        key: 'size',
        type: 'STRING',
        name: { uz: "Oʻlchami", uzCyrl: 'Ўлчами', ru: 'Размер', en: 'Size' },
        order: 0,
      },
      {
        key: 'color',
        type: 'STRING',
        name: { uz: 'Rangi', uzCyrl: 'Ранги', ru: 'Цвет', en: 'Colour' },
        order: 1,
      },
    ],
    children: [
      {
        slug: 'erkaklar-kiyimi',
        name: { uz: 'Erkaklar kiyimi', uzCyrl: 'Эркаклар кийими', ru: 'Мужская одежда', en: "Men's clothing" },
        defaultUnit: 'dona',
        allowedUnits: ['dona'],
      },
      {
        slug: 'ayollar-kiyimi',
        name: { uz: 'Ayollar kiyimi', uzCyrl: 'Аёллар кийими', ru: 'Женская одежда', en: "Women's clothing" },
        defaultUnit: 'dona',
        allowedUnits: ['dona'],
      },
      {
        slug: 'bolalar-kiyimi',
        name: { uz: 'Bolalar kiyimi', uzCyrl: 'Болалар кийими', ru: 'Детская одежда', en: "Children's clothing" },
        defaultUnit: 'dona',
        allowedUnits: ['dona'],
      },
      {
        slug: 'poyabzal',
        name: { uz: 'Poyabzal', uzCyrl: 'Пойабзал', ru: 'Обувь', en: 'Footwear' },
        defaultUnit: 'juft',
        allowedUnits: ['juft', 'dona'],
      },
      {
        slug: 'matolar',
        name: { uz: 'Matolar', uzCyrl: 'Матолар', ru: 'Ткани', en: 'Fabrics' },
        defaultUnit: 'metr',
        allowedUnits: ['metr'],
        defaultTolerancePercent: 500,
      },
    ],
  },
  {
    slug: 'uy-rozgor-buyumlari',
    name: { uz: "Uy-roʻzgʻor buyumlari", uzCyrl: 'Уй-рўзғор буюмлари', ru: 'Товары для дома', en: 'Household goods' },
    defaultUnit: 'dona',
    allowedUnits: ['dona', 'quti', 'litr', 'kg'],
    defaultTolerancePercent: 0,
    icon: 'home',
    children: [
      {
        slug: 'idish-tovoq',
        name: { uz: 'Idish-tovoq', uzCyrl: 'Идиш-товоқ', ru: 'Посуда', en: 'Tableware' },
        defaultUnit: 'dona',
        allowedUnits: ['dona', 'quti'],
      },
      {
        slug: 'tozalash-vositalari',
        name: { uz: 'Tozalash vositalari', uzCyrl: 'Тозалаш воситалари', ru: 'Моющие средства', en: 'Cleaning supplies' },
        defaultUnit: 'dona',
        allowedUnits: ['dona', 'litr', 'kg'],
      },
      {
        slug: 'toqimachilik',
        name: { uz: "Toʻqimachilik", uzCyrl: 'Тўқимачилик', ru: 'Текстиль', en: 'Home textiles' },
        defaultUnit: 'dona',
        allowedUnits: ['dona', 'metr'],
      },
    ],
  },
  {
    slug: 'gullar-va-osimliklar',
    name: { uz: "Gullar va oʻsimliklar", uzCyrl: 'Гуллар ва ўсимликлар', ru: 'Цветы и растения', en: 'Flowers & plants' },
    defaultUnit: 'dona',
    allowedUnits: ['dona', 'bogh'],
    defaultTolerancePercent: 0,
    icon: 'flower',
  },
];
