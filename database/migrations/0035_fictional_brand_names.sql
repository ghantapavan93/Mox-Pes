-- Book gap N30: the screens and the reporting layer showed a real company's brand names beside
-- synthetic numbers. The brands keep their ids (scope, URLs, the reporting contract and every
-- branch row use them); their names become fictional, as in lib/reference.ts.
update brands set name = 'Desert Range Pest' where id = 'moxie';
update brands set name = 'Copper Mesa Pest' where id = 'joshuas';
update brands set name = 'Bluepine Pest' where id = 'mission';
