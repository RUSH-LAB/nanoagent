// The page's words for the plugin's values: meals, nutrients, "how you eat" toggles, food groups
// and target presets. Every value here compiles to contract.py's types (Meal, Nutrient,
// Restrictions, Like, Bound); nothing else in the page names a tag or a nutrient key.

/** contract.Meal, in the order of a day. */
export const MEALS = ["breakfast", "lunch", "dinner"];
export const MEAL_WORDS = {
  breakfast: { one: "Breakfast", many: "breakfasts", lower: "breakfast" },
  lunch: { one: "Lunch", many: "lunches", lower: "lunch" },
  dinner: { one: "Dinner", many: "dinners", lower: "dinner" },
};

/** contract.Nutrient, with its words and unit. */
export const NUTRIENTS = [
  { key: "kcal", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
  { key: "saturated_fat", label: "Saturated fat", unit: "g" },
  { key: "cholesterol", label: "Cholesterol", unit: "mg" },
  { key: "sodium", label: "Sodium", unit: "mg" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fiber", label: "Fiber", unit: "g" },
  { key: "sugar", label: "Sugar", unit: "g" },
];
export const NUTRIENT = Object.fromEntries(NUTRIENTS.map((one) => [one.key, one]));

/** "How you eat": friendly toggles over Food.com's own tags (README: there is no vegetarian tag). */
export const RULES = [
  { id: "meatless", label: "Meatless", exclude: ["Meat", "Poultry"], hint: "No dish labelled Meat or Poultry on Food.com" },
  { id: "vegan", label: "Vegan", require: ["Vegan"], hint: "Only dishes labelled Vegan" },
  { id: "no-dessert", label: "No desserts", exclude: ["Dessert"], hint: "No dish labelled Dessert" },
  { id: "healthy", label: "Healthy", require: ["Healthy"], hint: "Only dishes labelled Healthy" },
  { id: "low-cholesterol", label: "Low cholesterol", require: ["Low Cholesterol"], hint: "Only dishes labelled Low Cholesterol" },
  { id: "kid-friendly", label: "Kid friendly", require: ["Kid Friendly"], hint: "Only dishes labelled Kid Friendly" },
];

/** Love / Like / Avoid, as contract.Like weights (people never see the numbers). */
export const LEVELS = [
  { id: "love", label: "Love", weight: 2 },
  { id: "like", label: "Like", weight: 1 },
  { id: "avoid", label: "Avoid", weight: -2 },
];
export const WEIGHT = Object.fromEntries(LEVELS.map((one) => [one.id, one.weight]));

/** Food groups a taste can be: a contract.Like's name, words and ignored phrases. */
export const FOOD_GROUPS = [
  { name: "dairy", words: ["milk", "cheese", "yogurt", "butter", "cream"], ignore: ["peanut butter", "almond butter", "apple butter", "coconut milk", "coconut cream", "almond milk", "soy milk", "cream of tartar"] },
  { name: "chocolate", words: ["chocolate", "cocoa"], ignore: [] },
  { name: "mushrooms", words: ["mushroom"], ignore: [] },
  { name: "spicy", words: ["spicy", "chili", "chile", "jalapeno", "cayenne", "sriracha", "hot sauce", "red pepper flakes"], ignore: ["chili powder"] },
  { name: "seafood", words: ["seafood", "fish", "salmon", "tuna", "shrimp", "crab", "cod", "tilapia", "scallop"], ignore: ["fish sauce"] },
  { name: "eggs", words: ["egg"], ignore: ["egg noodles"] },
  { name: "beans", words: ["bean", "lentil", "chickpea", "garbanzo"], ignore: ["green bean", "green beans", "vanilla bean", "jelly bean", "jelly beans"] },
  { name: "rice", words: ["rice"], ignore: ["rice vinegar", "rice wine", "rice paper", "rice krispies"] },
  { name: "pasta", words: ["pasta", "spaghetti", "penne", "macaroni", "noodle", "linguine", "fettuccine", "lasagna"], ignore: [] },
  { name: "potatoes", words: ["potato"], ignore: [] },
  { name: "chicken", words: ["chicken"], ignore: ["chicken broth", "chicken stock", "chicken bouillon"] },
  { name: "pork", words: ["pork", "bacon", "ham", "sausage"], ignore: [] },
  { name: "beef", words: ["beef", "steak"], ignore: ["beef broth", "beef stock", "beef bouillon"] },
  { name: "nuts", words: ["nut", "almond", "walnut", "pecan", "cashew", "peanut", "pistachio"], ignore: [] },
  { name: "fruit", words: ["fruit", "apple", "banana", "berry", "berries", "strawberries", "blueberries", "raspberries", "peach", "pear", "mango", "pineapple"], ignore: ["apple cider vinegar", "apple butter"] },
  { name: "garlic", words: ["garlic"], ignore: [] },
  { name: "onions", words: ["onion"], ignore: [] },
  { name: "tomatoes", words: ["tomato"], ignore: [] },
  { name: "coconut", words: ["coconut"], ignore: [] },
];

const b = (min = null, max = null) => ({ min, max });

/**
 * Target presets. A meal's depend on which meal it is; a day's are the day's totals (the
 * "balanced" one is the step 3 example's). Each was checked feasible on the Food.com build with
 * no rules and with Meatless (High protein is not feasible for Vegan breakfasts: the page says why).
 */
export const PRESETS = [
  {
    id: "balanced",
    label: "Balanced",
    meal: {
      breakfast: { kcal: b(null, 600), protein: b(15), sodium: b(null, 800) },
      lunch: { kcal: b(null, 800), protein: b(20), sodium: b(null, 1000) },
      dinner: { kcal: b(null, 800), protein: b(25), sodium: b(null, 1200) },
    },
    day: { kcal: b(1600, 2200), protein: b(90), fiber: b(30), sodium: b(null, 2300), saturated_fat: b(null, 22) },
  },
  {
    id: "high-protein",
    label: "High protein",
    meal: {
      breakfast: { protein: b(25), kcal: b(null, 700) },
      lunch: { protein: b(35), kcal: b(null, 900) },
      dinner: { protein: b(40), kcal: b(null, 1000) },
    },
    day: { kcal: b(1800, 2600), protein: b(130) },
  },
  {
    id: "light",
    label: "Light",
    meal: {
      breakfast: { kcal: b(null, 400), saturated_fat: b(null, 6) },
      lunch: { kcal: b(null, 500), saturated_fat: b(null, 8) },
      dinner: { kcal: b(null, 550), saturated_fat: b(null, 8) },
    },
    day: { kcal: b(1200, 1600), protein: b(60), fiber: b(25) },
  },
  {
    id: "low-sodium",
    label: "Low sodium",
    meal: {
      breakfast: { sodium: b(null, 500), kcal: b(null, 600) },
      lunch: { sodium: b(null, 600), kcal: b(null, 800) },
      dinner: { sodium: b(null, 700), kcal: b(null, 800) },
    },
    day: { kcal: b(1600, 2200), sodium: b(null, 1500) },
  },
  { id: "none", label: "No targets", meal: { breakfast: {}, lunch: {}, dinner: {} }, day: {} },
];

/** A preset's targets as editable rows, in NUTRIENTS order. */
export function presetRows(presetId, mode, meal) {
  const preset = PRESETS.find((one) => one.id === presetId);
  const bounds = mode === "day" ? preset.day : preset.meal[meal];
  return NUTRIENTS.filter((one) => bounds[one.key]).map((one) => ({ nutrient: one.key, ...bounds[one.key] }));
}

/** Tags that say how or how long a dish is cooked, or repeat its meal: not shown on dish cards. */
const NOISE = /^(< \d|Oven|Stove Top|Microwave|Broil\/Grill|Small Appliance|Refrigerator|Freezer|No Cook|Breakfast|Brunch|Lunch\/Snacks|One Dish Meal|For Large Groups|Free Of\.\.\.|High In\.\.\.|Low Protein|Very Low Carbs)/;
const FIRST = ["Vegan", "Healthy", "Low Cholesterol", "High Protein", "Spicy", "Easy", "Kid Friendly", "Inexpensive"];

/** Up to `limit` of a recipe's tags worth showing on its card. */
export function friendlyTags(tags, limit = 3) {
  const kept = tags.filter((tag) => !NOISE.test(tag));
  const rank = (tag) => (FIRST.includes(tag) ? FIRST.indexOf(tag) : FIRST.length);
  return [...kept].sort((x, y) => rank(x) - rank(y)).slice(0, limit);
}

/** Food.com's placeholder labels ("Free Of...", "High In...") mean nothing on their own. */
export const isListedTag = (tag) => !tag.endsWith("...");
