const phrases = {
  network: [
    "Poking the internet...",
    "Sending carrier pigeons...",
    "Warming up the tubes...",
    "Yelling into the void...",
    "Shaking hands with servers...",
    "Bribing the firewall...",
  ],
  ai: [
    "Neurons firing...",
    "Summoning the hive mind...",
    "Asking the oracle...",
    "Crunching brain juice...",
    "Consulting the crystal GPU...",
    "Waking up the braincells...",
  ],
  boot: [
    "Stretching before the sprint...",
    "Feeding the hamsters...",
    "Flipping all the switches...",
    "Revving the engine...",
    "Booting with enthusiasm...",
    "Dusting off the cobwebs...",
  ],
  gateway: [
    "Knocking on the gateway door...",
    "Waking up the gatekeeper...",
    "Dialing the mothership...",
    "Poking the gateway with a stick...",
    "Waiting for the drawbridge...",
    "Negotiating entry...",
  ],
  scan: [
    "Sniffing the network...",
    "Peeking under the hood...",
    "Scanning the premises...",
    "Looking for signs of life...",
    "Rummaging through ports...",
    "Playing hide and seek...",
  ],
  plan: [
    "Hatching a master plan...",
    "Sharpening the pencils...",
    "Drawing up the blueprints...",
    "Assembling the brain trust...",
    "Plotting world domination...",
    "Connecting the dots...",
  ],
  model: [
    "Browsing the model catalog...",
    "Window shopping for brains...",
    "Checking the lineup...",
    "Sizing up the options...",
  ],
  file: [
    "Rifling through files...",
    "Parsing the paperwork...",
    "Reading the fine print...",
    "Leafing through pages...",
  ],
} as const;

type Category = keyof typeof phrases;

export function randomPhrase(category: Category): string {
  const pool = phrases[category];
  return pool[Math.floor(Math.random() * pool.length)];
}
