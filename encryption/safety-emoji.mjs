// Emoji table adapted from matrix-org/matrix-spec v1.9 data-definitions/sas-emoji.json.
// Table licensed Apache-2.0; see MATRIX-LICENSE (Worker: ../MATRIX-LICENSE).
// Converted descriptions to name fields; the fingerprint derivation is this project's, not Matrix SAS.
// Fixed Matrix v1.9 SAS emoji table (names and order are protocol data).
// https://spec.matrix.org/v1.9/client-server-api/#sas-method-emoji
export const SAFETY_EMOJI = [
 {
  "emoji": "🐶",
  "name": "Dog"
 },
 {
  "emoji": "🐱",
  "name": "Cat"
 },
 {
  "emoji": "🦁",
  "name": "Lion"
 },
 {
  "emoji": "🐎",
  "name": "Horse"
 },
 {
  "emoji": "🦄",
  "name": "Unicorn"
 },
 {
  "emoji": "🐷",
  "name": "Pig"
 },
 {
  "emoji": "🐘",
  "name": "Elephant"
 },
 {
  "emoji": "🐰",
  "name": "Rabbit"
 },
 {
  "emoji": "🐼",
  "name": "Panda"
 },
 {
  "emoji": "🐓",
  "name": "Rooster"
 },
 {
  "emoji": "🐧",
  "name": "Penguin"
 },
 {
  "emoji": "🐢",
  "name": "Turtle"
 },
 {
  "emoji": "🐟",
  "name": "Fish"
 },
 {
  "emoji": "🐙",
  "name": "Octopus"
 },
 {
  "emoji": "🦋",
  "name": "Butterfly"
 },
 {
  "emoji": "🌷",
  "name": "Flower"
 },
 {
  "emoji": "🌳",
  "name": "Tree"
 },
 {
  "emoji": "🌵",
  "name": "Cactus"
 },
 {
  "emoji": "🍄",
  "name": "Mushroom"
 },
 {
  "emoji": "🌏",
  "name": "Globe"
 },
 {
  "emoji": "🌙",
  "name": "Moon"
 },
 {
  "emoji": "☁️",
  "name": "Cloud"
 },
 {
  "emoji": "🔥",
  "name": "Fire"
 },
 {
  "emoji": "🍌",
  "name": "Banana"
 },
 {
  "emoji": "🍎",
  "name": "Apple"
 },
 {
  "emoji": "🍓",
  "name": "Strawberry"
 },
 {
  "emoji": "🌽",
  "name": "Corn"
 },
 {
  "emoji": "🍕",
  "name": "Pizza"
 },
 {
  "emoji": "🎂",
  "name": "Cake"
 },
 {
  "emoji": "❤️",
  "name": "Heart"
 },
 {
  "emoji": "😀",
  "name": "Smiley"
 },
 {
  "emoji": "🤖",
  "name": "Robot"
 },
 {
  "emoji": "🎩",
  "name": "Hat"
 },
 {
  "emoji": "👓",
  "name": "Glasses"
 },
 {
  "emoji": "🔧",
  "name": "Spanner"
 },
 {
  "emoji": "🎅",
  "name": "Santa"
 },
 {
  "emoji": "👍",
  "name": "Thumbs Up"
 },
 {
  "emoji": "☂️",
  "name": "Umbrella"
 },
 {
  "emoji": "⌛",
  "name": "Hourglass"
 },
 {
  "emoji": "⏰",
  "name": "Clock"
 },
 {
  "emoji": "🎁",
  "name": "Gift"
 },
 {
  "emoji": "💡",
  "name": "Light Bulb"
 },
 {
  "emoji": "📕",
  "name": "Book"
 },
 {
  "emoji": "✏️",
  "name": "Pencil"
 },
 {
  "emoji": "📎",
  "name": "Paperclip"
 },
 {
  "emoji": "✂️",
  "name": "Scissors"
 },
 {
  "emoji": "🔒",
  "name": "Lock"
 },
 {
  "emoji": "🔑",
  "name": "Key"
 },
 {
  "emoji": "🔨",
  "name": "Hammer"
 },
 {
  "emoji": "☎️",
  "name": "Telephone"
 },
 {
  "emoji": "🏁",
  "name": "Flag"
 },
 {
  "emoji": "🚂",
  "name": "Train"
 },
 {
  "emoji": "🚲",
  "name": "Bicycle"
 },
 {
  "emoji": "✈️",
  "name": "Aeroplane"
 },
 {
  "emoji": "🚀",
  "name": "Rocket"
 },
 {
  "emoji": "🏆",
  "name": "Trophy"
 },
 {
  "emoji": "⚽",
  "name": "Ball"
 },
 {
  "emoji": "🎸",
  "name": "Guitar"
 },
 {
  "emoji": "🎺",
  "name": "Trumpet"
 },
 {
  "emoji": "🔔",
  "name": "Bell"
 },
 {
  "emoji": "⚓",
  "name": "Anchor"
 },
 {
  "emoji": "🎧",
  "name": "Headphones"
 },
 {
  "emoji": "📁",
  "name": "Folder"
 },
 {
  "emoji": "📌",
  "name": "Pin"
 }
];
// First 42 bits of the existing SHA-256 safety fingerprint, MSB first.
export function safetyEmojiFromHex(hex) {
 if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) throw Error("invalid safety fingerprint");
 const bits = BigInt("0x" + hex.slice(0, 12)) >> 6n;
 return Array.from({ length: 7 }, (_, i) => ({ ...SAFETY_EMOJI[Number((bits >> BigInt(36 - i * 6)) & 63n)] }));
}
