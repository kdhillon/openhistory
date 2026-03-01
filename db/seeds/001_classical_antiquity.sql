-- Seed: Classical Antiquity (500 BCE – 500 CE)
-- Years are stored as integers; negative = BCE, positive = CE.

-- ============================================================
-- Cities
-- ============================================================

INSERT INTO cities (id, name, wikipedia_title, wikipedia_summary, wikipedia_url, lng, lat, founded_year, founded_is_fuzzy, founded_range_min, founded_range_max, dissolved_year) VALUES

  ('11111111-0000-0000-0000-000000000001',
   'Athens',
   'Athens',
   'Athens is the capital and largest city of Greece. It dominates the region of Attica and is one of the world''s oldest cities, with its recorded history spanning over 3,400 years.',
   'https://en.wikipedia.org/wiki/Athens',
   23.7275, 37.9838,
   -3000, TRUE, -5000, -2000,
   NULL),

  ('11111111-0000-0000-0000-000000000002',
   'Rome',
   'Rome',
   'Rome is the capital city of Italy. It is also the capital of the Lazio region, the centre of the Metropolitan City of Rome Capital, and a special comune. With 2,860,009 residents in 1,285 km², it is also the country''s most populated comune.',
   'https://en.wikipedia.org/wiki/Rome',
   12.4964, 41.9028,
   -753, FALSE, NULL, NULL,
   NULL),

  ('11111111-0000-0000-0000-000000000003',
   'Alexandria',
   'Alexandria',
   'Alexandria is the second-largest city in Egypt and a major economic centre. Founded around 331 BC by Alexander the Great, Alexandria was the capital of the Ptolemaic Kingdom of Egypt.',
   'https://en.wikipedia.org/wiki/Alexandria',
   29.9187, 31.2001,
   -331, FALSE, NULL, NULL,
   NULL),

  ('11111111-0000-0000-0000-000000000004',
   'Carthage',
   'Carthage',
   'Carthage was an ancient Semitic city-state and civilization in North Africa. Founded by Phoenicians in the ninth century BC, it later became a major power in the Mediterranean.',
   'https://en.wikipedia.org/wiki/Carthage',
   10.3236, 36.8528,
   -814, FALSE, NULL, NULL,
   -146),

  ('11111111-0000-0000-0000-000000000005',
   'Jerusalem',
   'Jerusalem',
   'Jerusalem is a city in the Southern Levant, on a plateau in the Judaean Mountains between the Mediterranean and the Dead Sea. It is one of the oldest cities in the world.',
   'https://en.wikipedia.org/wiki/Jerusalem',
   35.2137, 31.7683,
   -3000, TRUE, -4000, -2000,
   NULL),

  ('11111111-0000-0000-0000-000000000006',
   'Babylon',
   'Babylon',
   'Babylon was an ancient Akkadian-speaking city in central-southern Mesopotamia (present-day Iraq). It was the capital city of the ancient Babylonian Empire.',
   'https://en.wikipedia.org/wiki/Babylon',
   44.4217, 32.5427,
   -2300, TRUE, -2500, -2000,
   NULL),

  ('11111111-0000-0000-0000-000000000007',
   'Syracuse',
   'Syracuse, Sicily',
   'Syracuse is a historic city on the island of Sicily, the capital of the Italian province of Syracuse. Founded by Ancient Greek colonists from Corinth in 734 BC, it was one of the most powerful cities of the ancient Mediterranean.',
   'https://en.wikipedia.org/wiki/Syracuse,_Sicily',
   15.2866, 37.0755,
   -734, FALSE, NULL, NULL,
   NULL),

  ('11111111-0000-0000-0000-000000000008',
   'Antioch',
   'Antioch',
   'Antioch on the Orontes was an ancient Greek city on the eastern side of the Orontes River. It was founded near the end of the 4th century BC by Seleucus I Nicator, one of Alexander the Great''s generals.',
   'https://en.wikipedia.org/wiki/Antioch',
   36.1948, 36.2021,
   -300, FALSE, NULL, NULL,
   NULL);

-- ============================================================
-- Events
-- ============================================================

INSERT INTO events (title, wikipedia_title, wikipedia_summary, wikipedia_url, year_start, year_end, date_is_fuzzy, date_range_min, date_range_max, location_level, lng, lat, location_id, location_name, categories) VALUES

  -- Point events (have their own coordinates)

  ('Battle of Thermopylae',
   'Battle of Thermopylae',
   'The Battle of Thermopylae was a battle between an alliance of Greek city-states led by King Leonidas I of Sparta, and the Achaemenid Empire of Xerxes I. It was fought over three days during the second Persian invasion of Greece.',
   'https://en.wikipedia.org/wiki/Battle_of_Thermopylae',
   -480, NULL, FALSE, NULL, NULL,
   'point', 22.5372, 38.7956, NULL, 'Thermopylae, Greece',
   ARRAY['battle']),

  ('Battle of Salamis',
   'Battle of Salamis',
   'The Battle of Salamis was a naval battle fought between an alliance of Greek city-states and the Achaemenid Empire in September 480 BC in the straits between the mainland and Salamis island.',
   'https://en.wikipedia.org/wiki/Battle_of_Salamis',
   -480, NULL, FALSE, NULL, NULL,
   'point', 23.4957, 37.9318, NULL, 'Salamis, Greece',
   ARRAY['battle']),

  ('Julius Caesar Crosses the Rubicon',
   'Crossing the Rubicon',
   'Crossing the Rubicon was the decisive step taken by Julius Caesar on January 10, 49 BC, when he led his army across the Rubicon river in northern Italy, an act which was considered an act of war against the Roman Senate.',
   'https://en.wikipedia.org/wiki/Crossing_the_Rubicon',
   -49, NULL, FALSE, NULL, NULL,
   'point', 12.2378, 44.1401, NULL, 'Rubicon River, Italy',
   ARRAY['politics']),

  ('Battle of Actium',
   'Battle of Actium',
   'The Battle of Actium was the decisive confrontation between Octavian and the combined forces of Mark Antony and Cleopatra. It took place on 2 September 31 BC near the ancient Greek city of Actium.',
   'https://en.wikipedia.org/wiki/Battle_of_Actium',
   -31, NULL, FALSE, NULL, NULL,
   'point', 20.7543, 38.9531, NULL, 'Actium, Greece',
   ARRAY['battle']),

  ('Birth of Jesus',
   'Jesus',
   'Jesus, also referred to as Jesus Christ, was a first-century Jewish preacher and religious leader. He is the central figure of Christianity, the world''s largest religion.',
   'https://en.wikipedia.org/wiki/Jesus',
   -4, NULL, TRUE, -7, -2,
   'point', 35.2078, 31.7045, NULL, 'Bethlehem',
   ARRAY['religion']),

  ('Eruption of Mount Vesuvius — Pompeii Destroyed',
   '79 AD eruption of Mount Vesuvius',
   'The 79 AD eruption of Mount Vesuvius was one of the deadliest in European history. A catastrophic eruption buried the Roman cities of Pompeii, Herculaneum, and several other settlements under volcanic ash and pumice.',
   'https://en.wikipedia.org/wiki/79_AD_eruption_of_Mount_Vesuvius',
   79, NULL, FALSE, NULL, NULL,
   'point', 14.4897, 40.8216, NULL, 'Mount Vesuvius, Italy',
   ARRAY['natural_disaster']),

  -- City-linked events (coordinates resolved via JOIN to cities table)

  ('Battle of Marathon',
   'Battle of Marathon',
   'The Battle of Marathon took place in 490 BC during the first Persian invasion of Greece. It was fought between the citizens of Athens, aided by Plataea, and a Persian force commanded by Datis and Artaphernes.',
   'https://en.wikipedia.org/wiki/Battle_of_Marathon',
   -490, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000001', 'Athens, Greece',
   ARRAY['battle']),

  ('Founding of Alexandria',
   'Alexandria',
   'Alexandria was founded around a small Ancient Egyptian town c. 331 BC by Alexander the Great. It became an important centre of Hellenistic civilisation and remained the capital of Ptolemaic Egypt and Roman and Byzantine Egypt for almost a thousand years.',
   'https://en.wikipedia.org/wiki/Alexandria',
   -331, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000003', 'Alexandria, Egypt',
   ARRAY['founding']),

  ('Death of Alexander the Great',
   'Alexander the Great',
   'Alexander III of Macedon, commonly known as Alexander the Great, was a king of the ancient Greek kingdom of Macedon. He died in Babylon in 323 BC at the age of 32.',
   'https://en.wikipedia.org/wiki/Alexander_the_Great',
   -323, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000006', 'Babylon',
   ARRAY['politics']),

  ('First Punic War Begins',
   'First Punic War',
   'The First Punic War was the first of three wars fought between Rome and Carthage, the two main powers of the western Mediterranean in the early 3rd century BC. It was fought primarily over control of Sicily.',
   'https://en.wikipedia.org/wiki/First_Punic_War',
   -264, -241, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000004', 'Carthage',
   ARRAY['battle', 'politics']),

  ('Destruction of Carthage',
   'Siege of Carthage (149–146 BC)',
   'The Siege of Carthage was the third and final war between the Roman Republic and the Carthaginian Empire. The Roman general Scipio Aemilianus besieged, captured, and utterly destroyed the city of Carthage in 146 BC.',
   'https://en.wikipedia.org/wiki/Siege_of_Carthage_(149%E2%80%93146_BC)',
   -146, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000004', 'Carthage',
   ARRAY['battle']),

  ('Assassination of Julius Caesar',
   'Assassination of Julius Caesar',
   'Julius Caesar, the Roman dictator, was assassinated by a group of senators on the Ides of March (15 March) of 44 BC. The senators stabbed Caesar 23 times in the Theatre of Pompey in Rome.',
   'https://en.wikipedia.org/wiki/Assassination_of_Julius_Caesar',
   -44, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000002', 'Rome',
   ARRAY['politics']),

  ('Destruction of the Second Temple, Jerusalem',
   'Siege of Jerusalem (70 CE)',
   'The siege of Jerusalem in 70 CE was the decisive event of the First Jewish–Roman War. The Roman army besieged and conquered the city of Jerusalem, destroying Herod''s Temple.',
   'https://en.wikipedia.org/wiki/Siege_of_Jerusalem_(70_CE)',
   70, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000005', 'Jerusalem',
   ARRAY['battle']),

  ('Trajan''s Dacian Wars Begin',
   'Dacian Wars',
   'The Dacian Wars were two military campaigns fought between the Roman Empire under Emperor Trajan and the Dacian kingdom of Decebalus. The wars culminated in Roman victory and the incorporation of Dacia as a Roman province.',
   'https://en.wikipedia.org/wiki/Dacian_Wars',
   101, 106, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000002', 'Rome',
   ARRAY['battle', 'politics']),

  ('Fall of the Western Roman Empire',
   'Fall of the Western Roman Empire',
   'The fall of the Western Roman Empire was the process of decline in the Western Roman Empire in which it failed to enforce its rule. The fall is dated to 476 AD when the last Roman emperor Romulus Augustulus was deposed by the Germanic chieftain Odoacer.',
   'https://en.wikipedia.org/wiki/Fall_of_the_Western_Roman_Empire',
   476, NULL, FALSE, NULL, NULL,
   'city', NULL, NULL, '11111111-0000-0000-0000-000000000002', 'Rome',
   ARRAY['politics']);
