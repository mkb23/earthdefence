// Game data: materials, asteroid types, missions and science facts.
(function () {
  const ED = (window.ED = window.ED || {});

  // ---------------------------------------------------------------------------
  // World constants (logical screen is 1280 x 720)
  // ---------------------------------------------------------------------------
  ED.VIEW = { w: 1280, h: 720 };
  ED.EARTH = { x: -90, y: 360, R: 262, atm: 304 };
  ED.ZONE = { x0: 290, y0: 92, x1: 760, y1: 628 };

  ED.SCALE = {
    KMS_PER_PX: 0.04, // 400 px/s on screen = 16 km/s
    IMPACTOR_KG: 1000, // a 1-tonne tungsten-tipped penetrator
    NUKE_TONS: 100000, // 100 kilotons of TNT
    PEN_MIN: 140, // px/s
    PEN_MAX: 400,
    MAX_DELAY: 8, // s: longest launch delay
  };

  // ---------------------------------------------------------------------------
  // Materials. Numbers are game-balance values, loosely inspired by real rock.
  //  strength: how hard bonds are to break      crush: how hard to pulverise
  //  absorb:   how much energy it soaks up       brittle: how far cracks run
  //  beta:     ejecta momentum boost             entry: how well it survives the atmosphere
  // ---------------------------------------------------------------------------
  ED.MATERIALS = {
    rock: { label: 'Solid rock', density: 1.0, strength: 1.0, crush: 1.0, absorb: 0.05, brittle: 1.0, beta: 2.2, entry: 1.0, color: '#8f8579' },
    core: { label: 'Rocky core', density: 1.25, strength: 1.35, crush: 1.25, absorb: 0.05, brittle: 0.9, beta: 2.0, entry: 1.0, color: '#6c6159' },
    fluff: { label: 'Fluffy regolith', density: 0.45, strength: 0.16, crush: 0.12, absorb: 0.3, brittle: 0.2, beta: 1.3, entry: 0.45, color: '#cdb99a' },
    shell: { label: 'Hard shell', density: 1.1, strength: 2.0, crush: 1.8, absorb: 0.04, brittle: 1.8, beta: 1.8, entry: 1.0, color: '#5a6170' },
    rubble: { label: 'Rubble', density: 0.8, strength: 0.9, crush: 0.5, absorb: 0.13, brittle: 0.6, beta: 3.5, entry: 0.75, color: '#9d8b75', loose: 0.07 },
    iron: { label: 'Iron-nickel metal', density: 2.4, strength: 2.6, crush: 2.6, absorb: 0.03, brittle: 0.5, beta: 1.4, entry: 2.4, color: '#9097a1' },
  };

  // ---------------------------------------------------------------------------
  // Asteroid types
  // ---------------------------------------------------------------------------
  ED.ASTEROID_TYPES = {
    solid: {
      name: 'Solid Rock',
      icon: '🪨',
      kgm3: 2600,
      layers: [['rock', 'Solid stone all the way through']],
      desc: 'One big chunk of solid stone. Strong, tough and hard to crack!',
      real: 'Small asteroids that spin round in just a few minutes must be solid – a loose pile of rubble spinning that fast would fly apart.',
      strategy: 'Hit it hard, near the middle. More hits = smaller pieces.',
      fact: 'monolith',
    },
    rubble: {
      name: 'Rubble Pile',
      icon: '🧺',
      kgm3: 1900,
      layers: [['rubble', 'Boulders, gravel and dust held together by weak gravity']],
      desc: 'A flying ball pit! Boulders and gravel loosely held together by their own tiny gravity.',
      real: 'Asteroids Bennu, Ryugu and Dimorphos (the one NASA’s DART hit) are rubble piles.',
      strategy: 'It breaks apart easily – but every boulder inside is still solid rock.',
      fact: 'rubble',
    },
    fluffy: {
      name: 'Fluffball',
      icon: '☁️',
      kgm3: 1800,
      layers: [['fluff', 'Fluffy outside: loose dust and gravel'], ['core', 'Hard rocky core']],
      desc: 'A hard rocky core wrapped in a thick blanket of fluffy dust. The fluff soaks up hits like a pillow!',
      real: 'Lots of asteroids are covered in loose dust called regolith. Comets are fluffier still – comet 67P is less dense than water!',
      strategy: 'Dig a tunnel through the fluff by hitting the same spot again and again – or let a nuke burrow in.',
      fact: 'fluffy',
    },
    pinata: {
      name: 'Piñata',
      icon: '🥚',
      kgm3: 2200,
      layers: [['shell', 'Tough hard shell'], ['rubble', 'Loose rubble inside']],
      desc: 'A super-tough shell with loose rubble inside. Crack the shell and the rubble can spill out!',
      real: 'Some scientists think asteroids might have a harder crust over a crumbly inside. Nobody knows for sure yet!',
      strategy: 'Crack the shell first. Then blast the rubble apart from the inside.',
      fact: 'shell',
    },
    iron: {
      name: 'Iron Asteroid',
      icon: '🔩',
      kgm3: 7800,
      layers: [['iron', 'Solid iron and nickel metal']],
      desc: 'Solid iron-nickel metal – super heavy and super strong. Metal chunks survive the trip through the air much better than rock!',
      real: 'Metal asteroids may be the leftover cores of baby planets that smashed apart. NASA’s Psyche spacecraft is flying to one.',
      strategy: 'You’ll need loads of power, and the pieces must be tiny – or pushed right past Earth.',
      fact: 'iron',
    },
  };

  // ---------------------------------------------------------------------------
  // What happens when a fragment hits the atmosphere (effective size in metres)
  // ---------------------------------------------------------------------------
  ED.OUTCOMES = {
    burn: { max: 15, label: 'Burned up', icon: '✨', color: '#7cf3c8', damage: 0, blurb: 'Burned up high in the sky like a shooting star. Totally safe!' },
    small: { max: 30, label: 'Small airburst', icon: '💥', color: '#ffd84d', damage: 1, blurb: 'Exploded in the sky – like Chelyabinsk in 2013. Windows rattle and break.' },
    big: { max: 80, label: 'Big airburst', icon: '🌲', color: '#ff9b3d', damage: 8, blurb: 'A huge explosion in the sky – like Tunguska in 1908. Forests flattened!' },
    ground: { max: Infinity, label: 'Ground impact', icon: '☄️', color: '#ff4d5e', damage: 25, blurb: 'Smashed into the ground and made a crater. Big trouble!' },
    miss: { label: 'Missed Earth', icon: '💨', color: '#8fb8ff', damage: 0, blurb: 'Flew safely past Earth.' },
  };

  ED.classifyEntry = function (effM) {
    if (effM < ED.OUTCOMES.burn.max) return 'burn';
    if (effM < ED.OUTCOMES.small.max) return 'small';
    if (effM < ED.OUTCOMES.big.max) return 'big';
    return 'ground';
  };
  ED.entryDamage = function (outcome, effM) {
    if (outcome === 'ground') return Math.round(25 * Math.pow(effM / 80, 1.5));
    return ED.OUTCOMES[outcome].damage;
  };
  // 0 stars: a crater, or lots of big airbursts. 1: no crater, a few big airbursts.
  // 2: at most one big airburst. 3: almost everything burned up or missed.
  ED.starsFor = function (stats) {
    if (stats.ground > 0 || stats.damage >= 60) return 0;
    if (stats.damage <= 3) return 3;
    if (stats.big <= 1 && stats.damage <= 14) return 2;
    return 1;
  };

  // ---------------------------------------------------------------------------
  // Nuke fuse settings
  // ---------------------------------------------------------------------------
  ED.FUSES = {
    manual: { icon: '🖐️', name: 'Manual', text: 'YOU press DETONATE! Time slows down as it gets close.' },
    standoff: { icon: '📡', name: 'Standoff', text: 'Explodes just above the surface. Pushes the rock without smashing it.' },
    contact: { icon: '💥', name: 'Contact', text: 'Explodes the instant it touches the asteroid.' },
    deep: { icon: '⛏️', name: 'Deep', text: 'Tries to burrow in first. Only works in soft fluff or a crater!' },
  };

  // ---------------------------------------------------------------------------
  // Missions
  // ---------------------------------------------------------------------------
  const E = ED.EARTH;
  // cellM = size of the smallest rock chunk in metres
  function ast(type, diameterM, radiusPx, cellM, seed, x, y, speed, aimDY, extra) {
    return Object.assign({ type, diameterM, radiusPx, cellM, seed, x, y, speed, aimX: E.x, aimY: E.y + aimDY, spin: 0, elong: 0 }, extra || {});
  }

  ED.LEVELS = [
    {
      id: 'first',
      name: 'First Strike',
      asteroids: [ast('solid', 100, 52, 10, 11, 1080, 300, 72, -150)],
      inventory: { kinetic: 3, nuke: 0 },
      tutorial: true,
      briefing: 'Astronomers have spotted a 100-metre space rock heading straight for Earth! Your job: launch kinetic impactors – heavy, super-fast spacecraft – to smash it into small pieces.',
      tip: 'Pick 🚀 below, then put an impactor in the green zone. The ✕ shows where it will hit!',
      facts: ['dart', 'atmosphere'],
    },
    {
      id: 'ballpit',
      name: 'Flying Ball Pit',
      asteroids: [ast('rubble', 160, 66, 11, 23, 1090, 420, 70, 150, { elong: 0.22, spin: 0.12 })],
      inventory: { kinetic: 3, nuke: 0 },
      briefing: 'This one is a rubble pile – boulders and gravel loosely stuck together, just like Dimorphos, the asteroid NASA’s DART spacecraft hit in 2022.',
      tip: 'Rubble piles crumble easily – but each boulder inside is solid. Spread your hits out!',
      facts: ['rubble', 'ejecta'],
    },
    {
      id: 'nudge',
      name: 'Gentle Nudge',
      asteroids: [ast('solid', 100, 50, 10, 17, 1080, 190, 72, -250, { spin: 0.05 })],
      inventory: { kinetic: 2, nuke: 0 },
      goal: 'deflect',
      briefing: 'This rock is only just going to clip the top of Earth’s atmosphere. You don’t have to smash it – a sideways NUDGE could make it miss completely. That’s exactly what NASA’s DART mission was testing!',
      tip: 'Hit it from BELOW so the push sends it UP and away. Slower impactors push without smashing – drag the aim handle shorter.',
      facts: ['deflection', 'momentum_energy'],
    },
    {
      id: 'tough',
      name: 'Tough Nut',
      asteroids: [ast('solid', 160, 76, 11, 37, 1100, 400, 70, 150, { spin: 0.1 })],
      inventory: { kinetic: 6, nuke: 0 },
      briefing: 'A tough solid rock – 160 metres across. One hit won’t be enough. Plan your swarm carefully!',
      tip: 'Look where its path meets Earth. Hit it from that side to push it – and its pieces – right past Earth!',
      facts: ['monolith', 'ke'],
    },
    {
      id: 'secondwave',
      name: 'Second Wave',
      asteroids: [ast('solid', 180, 80, 11, 59, 1100, 330, 70, 60, { spin: 0.08 })],
      inventory: { kinetic: 7, nuke: 0 },
      wave: true,
      briefing: 'Smashing this rock will leave big chunks still heading for Earth. Real defenders would send a second wave! Give some impactors a LAUNCH DELAY so they wait, then hunt down the biggest pieces.',
      tip: 'Select an impactor and press ⏱ + to delay its launch. Drag the 🔮 Mission computer slider to see the future pieces – then tap or click one to target it!',
      facts: ['simulation'],
    },
    {
      id: 'fluff',
      name: 'The Fluffball',
      asteroids: [ast('fluffy', 240, 98, 11, 41, 1100, 300, 68, -110, { spin: 0.08 })],
      inventory: { kinetic: 7, nuke: 0 },
      briefing: 'This asteroid has a hard rocky core hidden inside a deep blanket of fluffy dust. The fluff soaks up impacts like a pillow!',
      tip: 'Line up impactors one behind another (use ➕ Follower) to dig a tunnel to the core.',
      facts: ['fluffy'],
    },
    {
      id: 'nuclear',
      name: 'Nuclear Option',
      asteroids: [ast('solid', 300, 108, 12, 53, 1110, 360, 66, 90, { spin: 0.06 })],
      inventory: { kinetic: 2, nuke: 1 },
      defaultFuse: 'manual',
      briefing: 'A 300-metre monster. Kinetic impactors alone can’t break it – time to use a nuclear device. YOU decide exactly when it explodes!',
      tip: 'Time slows down as the nuke gets close. Press DETONATE (or Space) – just above the surface pushes, buried inside smashes!',
      facts: ['nuke_space', 'standoff'],
    },
    {
      id: 'pinata',
      name: 'The Piñata',
      asteroids: [ast('pinata', 300, 106, 12, 67, 1110, 300, 68, -100, { spin: 0.07 })],
      inventory: { kinetic: 4, nuke: 1 },
      briefing: 'A super-hard shell with loose rubble rattling around inside. Crack the shell, then scatter the rubble!',
      tip: 'Send impactors first to crack the shell, then a nuke just behind them to blow the rubble apart.',
      facts: ['shell'],
    },
    {
      id: 'haiv',
      name: 'Leader & Follower',
      asteroids: [ast('fluffy', 380, 120, 13, 79, 1110, 380, 64, 80, { spin: 0.05 })],
      inventory: { kinetic: 2, nuke: 2 },
      briefing: 'A giant Fluffball. Scientists have a clever idea for this: a kinetic “leader” digs a crater, and a nuclear “follower” flies into the hole and explodes underground.',
      tip: 'Select a kinetic impactor and press ➕☢️ Follower to put a nuke right behind it. Set its fuse to ⛏️ Deep!',
      facts: ['haiv'],
    },
    {
      id: 'iron',
      name: 'Heavy Metal',
      asteroids: [ast('iron', 160, 70, 9, 83, 1100, 330, 74, -120, { spin: 0.1 })],
      inventory: { kinetic: 5, nuke: 2 },
      goal: 'deflect',
      briefing: 'A chunk of solid iron-nickel metal. Iron is super strong, and metal fragments survive the atmosphere much better than rock. Smashing it might just make a shower of dangerous metal…',
      tip: 'Think DEFLECTION! Push it sideways with impactors from below, or a 📡 standoff blast just underneath it.',
      facts: ['iron', 'other_ways'],
    },
    {
      id: 'binary',
      name: 'Double Trouble',
      asteroids: [
        ast('solid', 240, 90, 11, 97, 1080, 270, 68, -60, { spin: 0.08 }),
        ast('rubble', 120, 44, 10, 98, 1165, 475, 68, 150, { spin: 0.2 }),
      ],
      inventory: { kinetic: 6, nuke: 2 },
      briefing: 'A binary asteroid – a big rock with a little moon! Just like Didymos and its moonlet Dimorphos. Two targets, one swarm.',
      tip: 'Share out your swarm. The little moon is heading for the bottom of Earth – a nudge downwards might be all it needs.',
      facts: ['binary', 'momentum'],
    },
    {
      id: 'big',
      name: 'The Big One',
      asteroids: [ast('pinata', 400, 125, 13, 113, 1115, 350, 72, 40, { spin: 0.05 })],
      inventory: { kinetic: 6, nuke: 4 },
      briefing: '400 metres of trouble – a giant Piñata asteroid. This is the big one. Use everything you have learned: cracking, buried blasts, deflection and second waves!',
      tip: 'Crack it open, blast it from inside, then use delayed impactors to knock the biggest pieces away from Earth.',
      facts: ['fragments', 'early', 'dinosaurs'],
    },
  ];
  // Mission order before the deflection update – used to carry over saved stars
  ED.OLD_LEVEL_ORDER = ['first', 'ballpit', 'tough', 'fluff', 'nuclear', 'pinata', 'haiv', 'iron', 'binary', 'big'];

  ED.SANDBOX_SIZES = {
    small: { diameterM: 120, radiusPx: 56, cellM: 10 },
    medium: { diameterM: 240, radiusPx: 96, cellM: 11 },
    large: { diameterM: 400, radiusPx: 124, cellM: 13 },
  };

  // ---------------------------------------------------------------------------
  // Science logbook
  // ---------------------------------------------------------------------------
  ED.FACTS = {
    dart: {
      icon: '🎯',
      title: 'NASA’s DART mission',
      text: 'In 2022 NASA deliberately crashed its DART spacecraft into a small asteroid called Dimorphos at about 6 km per second. It worked! Dimorphos’s orbit around its bigger partner got about 33 minutes shorter. It was the first time people ever changed how a space object moves.',
    },
    atmosphere: {
      icon: '🛡️',
      title: 'Earth’s air shield',
      text: 'Our atmosphere is a shield. Stony space rocks smaller than about 25 metres usually break up and explode high in the sky instead of hitting the ground. The smaller the pieces, the safer we are!',
    },
    ke: {
      icon: '⚡',
      title: 'Speed is power',
      text: 'Kinetic energy = ½ × mass × speed². Double the speed and you get FOUR times the energy! That’s why impactors fly so fast – a 1-tonne impactor at 16 km/s carries as much energy as about 30 tonnes of TNT.',
    },
    momentum: {
      icon: '🎱',
      title: 'Momentum',
      text: 'Momentum = mass × velocity. A small impactor can’t stop a huge asteroid, but in real life even a tiny nudge, given years in advance, adds up to missing Earth by thousands of kilometres.',
    },
    momentum_energy: {
      icon: '🎳',
      title: 'Push or smash?',
      text: 'Double an impactor’s speed and you double its PUSH (momentum) – but you get FOUR times the SMASH (energy). So a slow impactor gives a gentle nudge, while a fast one shatters the rock. Want to move an asteroid without breaking it? Go slower!',
    },
    deflection: {
      icon: '↗️',
      title: 'Push, don’t smash',
      text: 'Planetary defenders mostly plan to NUDGE dangerous asteroids, not blow them up. A small sideways push makes an asteroid miss Earth completely – with no dangerous fragments at all. That’s why NASA tested it with DART.',
    },
    early: {
      icon: '⏳',
      title: 'The earlier, the better',
      text: 'A push given 10 years before an asteroid arrives can be thousands of times smaller than one given a few days before, because the tiny change adds up over millions of kilometres. That’s why astronomers hunt for asteroids long before they get close – NASA is even building a space telescope called NEO Surveyor to find them.',
    },
    other_ways: {
      icon: '🧲',
      title: 'Other ways to move an asteroid',
      text: 'Scientists have dreamed up lots of ways to nudge an asteroid: a “gravity tractor” spacecraft that hovers nearby and pulls it with its own tiny gravity, an “ion beam” that blows on it for years, lasers that boil off its surface like a rocket – even painting one side so sunlight pushes it differently!',
    },
    simulation: {
      icon: '🔮',
      title: 'Mission computers',
      text: 'Before a real mission launches, scientists run thousands of computer simulations to predict what will happen – including where any pieces would fly. Your 🔮 Mission computer does the same thing with this game’s physics.',
    },
    ejecta: {
      icon: '🌋',
      title: 'The ejecta boost',
      text: 'When DART hit Dimorphos it blasted out a huge plume of rock and dust. That flying debris pushed back like a rocket, making the push about 3 to 4 times bigger than the spacecraft alone! Scientists call this boost “beta” (β).',
    },
    rubble: {
      icon: '🧺',
      title: 'Rubble piles',
      text: 'Many asteroids aren’t solid at all – they’re piles of boulders, pebbles and dust held together by their own tiny gravity. When NASA’s OSIRIS-REx touched asteroid Bennu in 2020, the surface was so loose the spacecraft would have sunk in if it hadn’t fired its thrusters!',
    },
    monolith: {
      icon: '🪨',
      title: 'Solid rocks',
      text: 'Some small asteroids spin round in just a few minutes. A rubble pile spinning that fast would fling itself apart, so these must be single solid rocks, held together by their own strength.',
    },
    fluffy: {
      icon: '☁️',
      title: 'Fluffy space rocks',
      text: 'Asteroids are often covered in loose dust and gravel called regolith. Comets are even fluffier – comet 67P is less dense than water! Soft, porous material crushes and soaks up the energy of an impact, like a pillow.',
    },
    shell: {
      icon: '🥚',
      title: 'Crusty shells?',
      text: 'Some scientists think certain asteroids might have a harder crust around a crumbly inside – like a piñata. We don’t know for sure yet! That’s why space missions visit asteroids to study them up close.',
    },
    iron: {
      icon: '🔩',
      title: 'Metal asteroids',
      text: 'Some asteroids are mostly iron and nickel – maybe leftover cores of baby planets that broke apart. NASA’s Psyche spacecraft is on its way to a giant metal-rich asteroid called 16 Psyche. Iron meteorites survive the fall through the air much better than stony ones.',
    },
    nuke_space: {
      icon: '☢️',
      title: 'Nukes in space',
      text: 'In space there’s no air, so a nuclear explosion makes no blast wave and no mushroom cloud. Instead, its X-rays and neutrons heat the rock so fast that the surface blasts off as vapour – pushing the asteroid like a rocket engine.',
    },
    standoff: {
      icon: '📡',
      title: 'The standoff burst',
      text: 'Exploding a nuke a little way above the surface heats one side of the asteroid and pushes it without smashing it. Scientists think this is often the safest way to use a nuke on an asteroid – no dangerous chunks!',
    },
    buried: {
      icon: '⛏️',
      title: 'Buried blasts',
      text: 'An explosion underground puts far more of its energy into the rock than one on the surface, where most of the energy just flies off into space. That’s why getting a nuke inside the asteroid makes such a difference.',
    },
    haiv: {
      icon: '🚀',
      title: 'Leader and follower',
      text: 'Engineers have designed a two-part spacecraft idea: a heavy “leader” smashes a crater, and a nuclear “follower” flies into the hole a split second later and explodes below the surface, where it is far more effective. It’s called HAIV – the Hypervelocity Asteroid Intercept Vehicle.',
    },
    crushed: {
      icon: '🥫',
      title: 'Too fast to dig',
      text: 'At over 10 km per second, a spacecraft hitting solid rock is destroyed in a tiny fraction of a second. A nuke can’t burrow into hard rock – it gets crushed! That’s why it needs soft ground or a crater to dig into.',
    },
    shooting_stars: {
      icon: '✨',
      title: 'Shooting stars',
      text: 'Shooting stars are bits of space dust – most smaller than a grain of sand – burning up about 80 to 100 km above your head, at speeds of up to 70 km per second. Earth sweeps up tonnes of space dust every single day!',
    },
    chelyabinsk: {
      icon: '💥',
      title: 'Chelyabinsk, 2013',
      text: 'On 15 February 2013 a space rock about 18–20 metres wide exploded around 30 km above Chelyabinsk in Russia. The blast was about 30 times more powerful than the Hiroshima bomb. It shattered windows across the city and about 1,500 people were hurt, mostly by flying glass.',
    },
    tunguska: {
      icon: '🌲',
      title: 'Tunguska, 1908',
      text: 'In 1908 an object roughly 50–60 metres across exploded over Siberia. It flattened about 80 million trees over more than 2,000 square kilometres – but it never even hit the ground!',
    },
    meteor_crater: {
      icon: '🏜️',
      title: 'Meteor Crater',
      text: 'About 50,000 years ago an iron asteroid around 50 metres wide hit Arizona, USA. It blasted a crater over 1 km wide and 170 metres deep. You can still visit it today!',
    },
    dinosaurs: {
      icon: '🦖',
      title: 'The dinosaur killer',
      text: '66 million years ago an asteroid about 10 km wide hit near Mexico, making the Chicxulub crater. It helped wipe out the dinosaurs (except the birds!). Astronomers have now found nearly all the really big asteroids near Earth – and none of them are heading our way.',
    },
    binary: {
      icon: '🌗',
      title: 'Asteroids with moons',
      text: 'Lots of asteroids have their own little moons! DART’s target Dimorphos is a moonlet about 150 metres wide, orbiting a bigger asteroid called Didymos that is roughly three-quarters of a kilometre across.',
    },
    fragments: {
      icon: '🔫',
      title: 'Cannonball or shotgun?',
      text: 'Breaking an asteroid can be risky: if the pieces are still big and still heading for Earth, it’s like swapping a cannonball for a shotgun blast. Scientists prefer to nudge asteroids gently – or break them so hard that the pieces spread out and miss.',
    },
    gravity: {
      icon: '🌍',
      title: 'Gravity pulls',
      text: 'Earth’s gravity bends the paths of objects passing nearby, pulling them in a little. Watch how fragments curve as they get close to Earth!',
    },
    scale: {
      icon: '📏',
      title: 'Not to scale!',
      text: 'This game squeezes everything to fit on screen and slows time down. The real atmosphere is as thin as the skin on an apple, and real asteroids are tiny compared to Earth. Real defence missions would hit an asteroid years before it arrives, when even a small nudge is enough.',
    },
    apophis: {
      icon: '🔭',
      title: 'Apophis, 2029',
      text: 'On 13 April 2029 the asteroid Apophis – about 340 metres wide – will zoom past Earth closer than some satellites. Don’t worry, it will definitely miss! People in some places may even see it without a telescope.',
    },
  };
  ED.FACT_ORDER = Object.keys(ED.FACTS);
})();
