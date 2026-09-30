// "Surprise me" pool — English prompts (the model was trained on English captions).
export const PROMPTS = [
  "a sea jellyfish floating in the pitch-black ocean depths",
  "a lighthouse above violet clouds at dusk",
  "a tiny astronaut riding a giant snail through a candy forest",
  "a cyberpunk fox DJ at a neon rooftop party",
  "an origami dragon breathing paper fire",
  "a cozy bookshop inside a hollow tree, warm lantern light",
  "a robot gardener watering glowing moonflowers",
  "a whale swimming through a sky of clouds above a village",
  "a knight cat in golden armor holding a tiny sword",
  "a magical train crossing a bridge made of rainbows",
  "a steampunk owl with brass wings in a victorian library",
  "a crystal castle growing from a frozen lake at sunrise",
  "a pirate ship sailing on a sea of stars",
  "a sushi platter floating in outer space",
  "a sunny italian piazza with a vespa and a gelato stand",
  "a dragon curled around a volcano like a kitten",
  "a mushroom village at night lit by firefly lanterns",
  "a retro-futuristic 80s car driving into a synthwave sunset",
  "a giant turtle carrying a forest on its back",
  "a wizard's desk covered in glowing potions and ancient books",
  "a polar bear made of aurora lights dancing on ice",
  "a hot air balloon shaped like a jellyfish over paris",
  "a samurai frog under cherry blossoms in the rain",
  "an astronaut cat planting a flag on the moon",
  "a cozy cabin in a snowy forest with warm glowing windows",
  "a clockwork hummingbird sipping from a glass flower",
  "a library where books fly around like birds",
  "a fox made of autumn leaves running through morning fog",
  "a deep-sea diver discovering a sunken amusement park",
  "a treehouse city connected by rope bridges at dusk",
  "a chef octopus making pizza in an underwater kitchen",
  "a glass rabbit filled with fireflies in a dark forest",
];

export function randomPrompt(exclude = "", rand: () => number = Math.random): string {
  let p = exclude;
  for (let guard = 0; p === exclude && guard < 10; guard++) {
    p = PROMPTS[Math.floor(rand() * PROMPTS.length)];
  }
  return p;
}
