import type { MemorySource } from '@shared/memory/sources'

/**
 * The story-memory test book (F-16.3; design §2.3, "Measuring accuracy without a gold set", 4).
 * Test data only: it feeds P2a's `reader.v1` and `verify.v1` eval cases and the live
 * planted-error run that is P2a's merge condition, P2b's knows scoring and P4's contradiction
 * scoring. Nothing in the app imports it, so it is never bundled into the renderer.
 *
 * Source. Scenes s01–s05 are adapted excerpts of chapters 1, 2, 3, 6 and 18 of *Pride and
 * Prejudice* by Jane Austen (1813; public domain, Project Gutenberg eBook #1342), shortened in
 * places. Scenes h01–h10 are original, written for this book.
 *
 * Disguise. Every name and place is changed, so a model that answers from memory of the novel
 * answers wrongly, which shows up in scoring:
 * Mr. and Mrs. Bennet → Mr. and Mrs. Harrow; Jane → Johanna; Elizabeth (Lizzy, Eliza) → Liesel
 * (Lise); Kitty → Bel (Isabel); Lydia → Lottie; Mary → (left out); Bingley → Ned Ashby; Miss
 * Bingley → Celia Ashby; Mr. and Mrs. Hurst → Mr. and Mrs. Lowther; Darcy → Callum Varrow; Sir
 * William and Lady Lucas → Sir Walter and Lady Pell; Charlotte Lucas → Clara Pell; Mrs. Long →
 * Mrs. Tull; Wickham → Mr. Dunmore; Mr. Collins → Mr. Pruett; Lady Catherine de Bourgh → Lady
 * Agatha Strand; Denny → Mr. Rook; Mr. Morris → Mr. Garth; Netherfield → Thornmere; Longbourn →
 * Wexley; Meryton → Callow Cross; Lucas Lodge → Pell House; Pemberley → Greyhallow; Derbyshire →
 * Elsdale; Hertfordshire → the county; London → Vellmouth; St. James's → the Vellmouth Rooms;
 * Brighton (in the original scenes) → Gullhaven. The novel's famous first sentence is
 * paraphrased, so no opening line gives the source away.
 *
 * Changed facts (`TEST_BOOK_SOURCE.changedFacts`): the Harrows have four daughters, not five;
 * Ashby has seven thousand a year; Varrow's eyes are grey (the novel never says); Dunmore is
 * named in narration as the late steward's son at Greyhallow.
 */

export type TestBookSource = Extract<
  MemorySource,
  'scene' | 'ideaScene' | 'inactiveDraft' | 'excludedScene'
>

export interface TestBookScene {
  /** `s` for the adapted excerpts, `h` for the original hard cases. */
  id: string
  chapter: number
  title: string
  /** Where the scene sits: a manuscript scene is read; every other source never is. */
  source: TestBookSource
  /** Typed scene details (F-16.11): record ids for POV and place, free text for time. */
  details?: { pov?: string; place?: string; time?: string; year?: number }
  paragraphs: readonly string[]
}

export const TEST_BOOK_SOURCE = {
  title: 'Pride and Prejudice',
  author: 'Jane Austen',
  year: 1813,
  gutenbergEbook: 1342,
  adapted: ['s01', 's02', 's03', 's04', 's05'],
  changedFacts: [
    'The Harrows have four daughters, not five.',
    'Ashby has seven thousand a year.',
    "Varrow's eyes are grey.",
    "Dunmore is named in narration as the late steward's son at Greyhallow."
  ]
} as const

export const TEST_BOOK: readonly TestBookScene[] = [
  {
    id: 's01',
    chapter: 1,
    title: 'Thornmere is let',
    source: 'scene',
    details: { place: 'wexley', year: 1811, time: 'autumn' },
    paragraphs: [
      `It was held as settled by every family in the county, that an unmarried man with a large income must be looking about him for a wife.`,
      `However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.`,
      `"My dear Mr. Harrow," said his lady to him one day, "have you heard that Thornmere Hall is let at last?"`,
      `Mr. Harrow replied that he had not.`,
      `"But it is," returned she; "for Mrs. Tull has just been here, and she told me all about it."`,
      `Mr. Harrow made no answer.`,
      `"Do you not want to know who has taken it?" cried his wife impatiently.`,
      `"You want to tell me, and I have no objection to hearing it."`,
      `This was invitation enough.`,
      `"Why, my dear, you must know, Mrs. Tull says that Thornmere is taken by a young man of large fortune from the north of England; that he came down on Monday in a chaise and four to see the place, and was so much delighted with it that he agreed with Mr. Garth immediately; that he is to take possession before Michaelmas, and some of his servants are to be in the house by the end of next week."`,
      `"What is his name?"`,
      `"Ashby."`,
      `"Is he married or single?"`,
      `"Oh! single, my dear, to be sure! A single man of large fortune; seven thousand a year. What a fine thing for our girls!"`,
      `"How so? how can it affect them?"`,
      `"My dear Mr. Harrow," replied his wife, "how can you be so tiresome! You must know that I am thinking of his marrying one of them."`,
      `"Is that his design in settling here?"`,
      `"Design! nonsense, how can you talk so! But it is very likely that he may fall in love with one of them, and therefore you must visit him as soon as he comes."`,
      `"I see no occasion for that. You and the girls may go, or you may send them by themselves, which perhaps will be still better; for as you are as handsome as any of them, Mr. Ashby might like you the best of the party."`,
      `"My dear, you flatter me. I certainly have had my share of beauty, but I do not pretend to be anything extraordinary now. When a woman has four grown-up daughters, she ought to give over thinking of her own beauty."`,
      `"In such cases, a woman has not often much beauty to think of."`,
      `"But, my dear, you must indeed go and see Mr. Ashby when he comes into the neighbourhood."`,
      `"It is more than I engage for, I assure you."`,
      `"But consider your daughters. Only think what an establishment it would be for one of them. Sir Walter and Lady Pell are determined to go, merely on that account; for in general, you know, they visit no new comers. Indeed you must go, for it will be impossible for us to visit him, if you do not."`,
      `"You are over scrupulous, surely. I dare say Mr. Ashby will be very glad to see you; and I will send a few lines by you to assure him of my hearty consent to his marrying whichever he chooses of the girls; though I must throw in a good word for my little Lise."`,
      `"I desire you will do no such thing. Lise is not a bit better than the others; and I am sure she is not half so handsome as Johanna, nor half so good-humoured as Lottie. But you are always giving her the preference."`,
      `"They have none of them much to recommend them," replied he; "they are all silly and ignorant like other girls; but Lise has something more of quickness than her sisters."`,
      `"Mr. Harrow, how can you abuse your own children in such a way? You take delight in vexing me. You have no compassion on my poor nerves."`,
      `"You mistake me, my dear. I have a high respect for your nerves. They are my old friends. I have heard you mention them with consideration these twenty years at least."`,
      `"Ah! you do not know what I suffer."`,
      `"But I hope you will get over it, and live to see many young men of seven thousand a year come into the neighbourhood."`,
      `"It will be no use to us if twenty such should come, since you will not visit them."`,
      `"Depend upon it, my dear, that when there are twenty I will visit them all."`,
      `Mr. Harrow was so odd a mixture of quick parts, sarcastic humour, reserve, and caprice, that the experience of three and twenty years had been insufficient to make his wife understand his character. Her mind was less difficult to develop. She was a woman of mean understanding, little information, and uncertain temper. When she was discontented, she fancied herself nervous. The business of her life was to get her daughters married; its solace was visiting and news.`
    ]
  },
  {
    id: 's02',
    chapter: 2,
    title: "Mr. Harrow's visit",
    source: 'scene',
    details: { place: 'wexley', year: 1811, time: 'autumn' },
    paragraphs: [
      `Mr. Harrow was among the earliest of those who waited on Mr. Ashby. He had always intended to visit him, though to the last always assuring his wife that he should not go; and till the evening after the visit was paid she had no knowledge of it. It was then disclosed in the following manner. Observing his second daughter employed in trimming a hat, he suddenly addressed her with,`,
      `"I hope Mr. Ashby will like it, Lise."`,
      `"We are not in a way to know what Mr. Ashby likes," said her mother resentfully, "since we are not to visit."`,
      `"But you forget, mamma," said Liesel, "that we shall meet him at the assemblies, and that Mrs. Tull has promised to introduce him."`,
      `"I do not believe Mrs. Tull will do any such thing. She has two nieces of her own. She is a selfish, hypocritical woman, and I have no opinion of her."`,
      `"No more have I," said Mr. Harrow; "and I am glad to find that you do not depend on her serving you."`,
      `Mrs. Harrow deigned not to make any reply; but, unable to contain herself, began scolding one of her daughters.`,
      `"Don't keep coughing so, Bel, for heaven's sake! Have a little compassion on my nerves. You tear them to pieces."`,
      `"Bel has no discretion in her coughs," said her father; "she times them ill."`,
      `"I do not cough for my own amusement," replied Bel fretfully. "When is your next ball to be, Lise?"`,
      `"To-morrow fortnight."`,
      `"Aye, so it is," cried her mother, "and Mrs. Tull does not come back till the day before; so it will be impossible for her to introduce him, for she will not know him herself."`,
      `"Then, my dear, you may have the advantage of your friend, and introduce Mr. Ashby to her."`,
      `"Impossible, Mr. Harrow, impossible, when I am not acquainted with him myself; how can you be so teasing?"`,
      `"I honour your circumspection. A fortnight's acquaintance is certainly very little. One cannot know what a man really is by the end of a fortnight. But if we do not venture, somebody else will; and after all, Mrs. Tull and her nieces must stand their chance; and therefore, as she will think it an act of kindness, if you decline the office, I will take it on myself."`,
      `The girls stared at their father. Mrs. Harrow said only, "Nonsense, nonsense!"`,
      `"What can be the meaning of that emphatic exclamation?" cried he. "Do you consider the forms of introduction, and the stress that is laid on them, as nonsense? I cannot quite agree with you there. But let us return to Mr. Ashby."`,
      `"I am sick of Mr. Ashby," cried his wife.`,
      `"I am sorry to hear that; but why did not you tell me so before? If I had known as much this morning, I certainly would not have called on him. It is very unlucky; but as I have actually paid the visit, we cannot escape the acquaintance now."`,
      `The astonishment of the ladies was just what he wished; that of Mrs. Harrow perhaps surpassing the rest; though when the first tumult of joy was over, she began to declare that it was what she had expected all the while.`,
      `"How good it was in you, my dear Mr. Harrow! But I knew I should persuade you at last. I was sure you loved your girls too well to neglect such an acquaintance. Well, how pleased I am! and it is such a good joke, too, that you should have gone this morning, and never said a word about it till now."`,
      `"Now, Bel, you may cough as much as you choose," said Mr. Harrow; and, as he spoke, he left the room, fatigued with the raptures of his wife.`,
      `"What an excellent father you have, girls," said she, when the door was shut. "I do not know how you will ever make him amends for his kindness; or me either, for that matter. At our time of life, it is not so pleasant, I can tell you, to be making new acquaintance every day; but for your sakes, we would do anything. Lottie, my love, though you are the youngest, I dare say Mr. Ashby will dance with you at the next ball."`,
      `"Oh!" said Lottie stoutly, "I am not afraid; for though I am the youngest, I'm the tallest."`,
      `The rest of the evening was spent in conjecturing how soon he would return Mr. Harrow's visit, and determining when they should ask him to dinner.`
    ]
  },
  {
    id: 's03',
    chapter: 3,
    title: 'The assembly at Callow Cross',
    source: 'scene',
    details: { place: 'callow-cross', year: 1811, time: 'autumn' },
    paragraphs: [
      `Not all that Mrs. Harrow, however, with the assistance of her four daughters, could ask on the subject, was sufficient to draw from her husband any satisfactory description of Mr. Ashby. They attacked him in various ways; with barefaced questions, ingenious suppositions, and distant surmises; but he eluded the skill of them all; and they were at last obliged to accept the second-hand intelligence of their neighbour, Lady Pell. Her report was highly favourable. Sir Walter had been delighted with him. He was quite young, wonderfully handsome, extremely agreeable, and, to crown the whole, he meant to be at the next assembly with a large party. Nothing could be more delightful! To be fond of dancing was a certain step towards falling in love; and very lively hopes of Mr. Ashby's heart were entertained.`,
      `"If I can but see one of my daughters happily settled at Thornmere," said Mrs. Harrow to her husband, "and all the others equally well married, I shall have nothing to wish for."`,
      `In a few days Mr. Ashby returned Mr. Harrow's visit, and sat about ten minutes with him in his library. He had entertained hopes of being admitted to a sight of the young ladies, of whose beauty he had heard much; but he saw only the father. The ladies were somewhat more fortunate, for they had the advantage of ascertaining, from an upper window, that he wore a blue coat and rode a black horse.`,
      `An invitation to dinner was soon afterwards dispatched; and already had Mrs. Harrow planned the courses that were to do credit to her housekeeping, when an answer arrived which deferred it all. Mr. Ashby was obliged to be in town the following day, and consequently unable to accept the honour of their invitation. Mrs. Harrow was quite disconcerted. She could not imagine what business he could have in town so soon after his arrival in the county; and she began to fear that he might be always flying about from one place to another, and never settled at Thornmere as he ought to be. Lady Pell quieted her fears a little by starting the idea of his being gone to Vellmouth only to get a large party for the ball; and a report soon followed that Mr. Ashby was to bring twelve ladies and seven gentlemen with him to the assembly. The girls grieved over such a number of ladies; but were comforted the day before the ball by hearing that, instead of twelve, he had brought only six with him from Vellmouth, his five sisters and a cousin. And when the party entered the assembly room, it consisted of only five altogether: Mr. Ashby, his two sisters, the husband of the eldest, and another young man.`,
      `Mr. Ashby was good-looking and gentlemanlike; he had a pleasant countenance, and easy, unaffected manners. His sisters were fine women, with an air of decided fashion. His brother-in-law, Mr. Lowther, merely looked the gentleman; but his friend Mr. Varrow soon drew the attention of the room by his fine, tall person, handsome features, noble mien, and the report, which was in general circulation within five minutes after his entrance, of his having ten thousand a year. Mr. Varrow's eyes were a cold, clear grey, and they rested on nobody for long. The gentlemen pronounced him to be a fine figure of a man, the ladies declared he was much handsomer than Mr. Ashby, and he was looked at with great admiration for about half the evening, till his manners gave a disgust which turned the tide of his popularity; for he was discovered to be proud, to be above his company, and above being pleased; and not all his large estate in Elsdale could save him from having a most forbidding, disagreeable countenance, and being unworthy to be compared with his friend.`,
      `Mr. Ashby had soon made himself acquainted with all the principal people in the room: he was lively and unreserved, danced every dance, was angry that the ball closed so early, and talked of giving one himself at Thornmere. Such amiable qualities must speak for themselves. What a contrast between him and his friend! Mr. Varrow danced only once with Mrs. Lowther and once with Miss Ashby, declined being introduced to any other lady, and spent the rest of the evening in walking about the room, speaking occasionally to one of his own party. His character was decided. He was the proudest, most disagreeable man in the world, and everybody hoped that he would never come there again. Amongst the most violent against him was Mrs. Harrow, whose dislike of his general behaviour was sharpened into particular resentment by his having slighted one of her daughters.`,
      `Liesel Harrow had been obliged, by the scarcity of gentlemen, to sit down for two dances; and during part of that time, Mr. Varrow had been standing near enough for her to overhear a conversation between him and Mr. Ashby, who came from the dance for a few minutes to press his friend to join it.`,
      `"Come, Varrow," said he, "I must have you dance. I hate to see you standing about by yourself in this stupid manner. You had much better dance."`,
      `"I certainly shall not. You know how I detest it, unless I am particularly acquainted with my partner. At such an assembly as this, it would be insupportable. Your sisters are engaged, and there is not another woman in the room whom it would not be a punishment to me to stand up with."`,
      `"I would not be so fastidious as you are," cried Mr. Ashby, "for a kingdom! Upon my honour, I never met with so many pleasant girls in my life as I have this evening; and there are several of them, you see, uncommonly pretty."`,
      `"You are dancing with the only handsome girl in the room," said Mr. Varrow, looking at the eldest Miss Harrow.`,
      `"Oh, she is the most beautiful creature I ever beheld! But there is one of her sisters sitting down just behind you, who is very pretty, and I dare say very agreeable. Do let me ask my partner to introduce you."`,
      `"Which do you mean?" and turning round, he looked for a moment at Liesel, till, catching her eye, he withdrew his own, and coldly said, "She is tolerable; but not handsome enough to tempt me; and I am in no humour at present to give consequence to young ladies who are slighted by other men. You had better return to your partner and enjoy her smiles, for you are wasting your time with me."`,
      `Mr. Ashby followed his advice. Mr. Varrow walked off; and Liesel remained with no very cordial feelings towards him. She told the story, however, with great spirit among her friends; for she had a lively, playful disposition, which delighted in anything ridiculous.`,
      `The evening altogether passed off pleasantly to the whole family. Mrs. Harrow had seen her eldest daughter much admired by the Thornmere party. Mr. Ashby had danced with her twice, and she had been distinguished by his sisters. Johanna was as much gratified by this as her mother could be, though in a quieter way. Liesel felt Johanna's pleasure. Bel and Lottie had been fortunate enough to be never without partners, which was all that they had yet learnt to care for at a ball. They returned, therefore, in good spirits to Wexley, the village where they lived, and of which they were the principal inhabitants.`,
      `They found Mr. Harrow still up. With a book he was regardless of time; and on the present occasion he had a good deal of curiosity as to the event of an evening which had raised such splendid expectations. He had rather hoped that all his wife's views on the stranger would be disappointed; but he soon found that he had a very different story to hear.`,
      `"Oh, my dear Mr. Harrow," as she entered the room, "we have had a most delightful evening, a most excellent ball. I wish you had been there. Johanna was so admired, nothing could be like it. Everybody said how well she looked; and Mr. Ashby thought her quite beautiful, and danced with her twice. Only think of that, my dear: he actually danced with her twice; and she was the only creature in the room that he asked a second time. First of all, he asked Miss Pell. I was so vexed to see him stand up with her; but, however, he did not admire her at all: indeed, nobody can, you know; and he seemed quite struck with Johanna as she was going down the dance. So he inquired who she was, and got introduced, and asked her for the two next."`,
      `"If he had had any compassion for me," cried her husband impatiently, "he would not have danced half so much! For God's sake, say no more of his partners. O that he had sprained his ankle in the first dance!"`,
      `"Oh, my dear," continued Mrs. Harrow, "I am quite delighted with him. He is so excessively handsome! and his sisters are charming women. But I can assure you," she added, "that Lise does not lose much by not suiting his fancy; for he is a most disagreeable, horrid man, not at all worth pleasing. So high and so conceited, that there was no enduring him! He walked here, and he walked there, fancying himself so very great! Not handsome enough to dance with! I wish you had been there, my dear, to have given him one of your set-downs. I quite detest the man."`
    ]
  },
  {
    id: 's04',
    chapter: 4,
    title: 'Pell House',
    source: 'scene',
    details: { place: 'pell-house', year: 1811, time: 'autumn' },
    paragraphs: [
      `The ladies of Wexley soon waited on those of Thornmere. The visit was returned in due form. Miss Harrow's pleasing manners grew on the good-will of Mrs. Lowther and Miss Ashby; and though the mother was found to be intolerable, and the younger sisters not worth speaking to, a wish of being better acquainted with them was expressed towards the two eldest. By Johanna this attention was received with the greatest pleasure; but Liesel still saw superciliousness in their treatment of everybody, hardly excepting even her sister, and could not like them.`,
      `It was generally evident, whenever they met, that Mr. Ashby did admire Johanna; and to Liesel it was equally evident that Johanna was yielding to the preference which she had begun to entertain for him from the first, and was in a way to be very much in love; but she considered with pleasure that it was not likely to be discovered by the world in general, since Johanna united with great strength of feeling a composure of temper and an uniform cheerfulness of manner, which would guard her from the suspicions of the impertinent. She mentioned this to her friend, Miss Pell.`,
      `"It may perhaps be pleasant," replied Clara, "to be able to impose on the public in such a case; but it is sometimes a disadvantage to be so very guarded. If a woman conceals her affection with the same skill from the object of it, she may lose the opportunity of fixing him; and it will then be but poor consolation to believe the world equally in the dark. Happiness in marriage is entirely a matter of chance. If the dispositions of the parties are ever so well known to each other, or ever so similar beforehand, it does not advance their felicity in the least."`,
      `"You make me laugh, Clara; but it is not sound. You know it is not sound, and that you would never act in this way yourself."`,
      `Occupied in observing Mr. Ashby's attentions to her sister, Liesel was far from suspecting that she was herself becoming an object of some interest in the eyes of his friend. Mr. Varrow had at first scarcely allowed Liesel to be pretty; he had looked at her without admiration at the ball; and when they next met, he looked at her only to criticise. But no sooner had he made it clear to himself and his friends that she had hardly a good feature in her face, than he began to find it was rendered uncommonly intelligent by the beautiful expression of her dark eyes. To this discovery succeeded some others equally mortifying. Though he had detected with a critical eye more than one failure of perfect symmetry in her form, he was forced to acknowledge her figure to be light and pleasing.`,
      `He began to wish to know more of her; and, as a step towards conversing with her himself, attended to her conversation with others. His doing so drew her notice. It was at Sir Walter Pell's, where a large party were assembled.`,
      `"What does Mr. Varrow mean," said she to Clara, "by listening to my conversation with Colonel Hale?"`,
      `"That is a question which Mr. Varrow only can answer."`,
      `"But if he does it any more, I shall certainly let him know that I see what he is about. He has a very satirical eye, and if I do not begin by being impertinent myself, I shall soon grow afraid of him."`,
      `Sir Walter Pell, coming up to Mr. Varrow while the young people danced, began: "What a charming amusement for young people this is, Mr. Varrow! There is nothing like dancing, after all. I consider it as one of the first refinements of polished societies."`,
      `"Certainly, sir; and it has the advantage also of being in vogue amongst the less polished societies of the world: every savage can dance."`,
      `Sir Walter only smiled. "Your friend performs delightfully," he continued, after a pause, on seeing Mr. Ashby join the group; "and I doubt not that you are an adept in the science yourself, Mr. Varrow. Do you often dance at the Vellmouth Rooms?"`,
      `"Never, sir."`,
      `Sir Walter Pell, who had been formerly in trade in Callow Cross, was all politeness. Seeing Mr. Varrow near Liesel, he called out to her, "My dear Miss Liesel, why are not you dancing? Mr. Varrow, you must allow me to present this young lady to you as a very desirable partner. You cannot refuse to dance, I am sure, when so much beauty is before you."`,
      `He took her hand, with the intention of giving it to Mr. Varrow, who, though extremely surprised, was not unwilling to receive it, when she instantly drew back, and said with some discomposure to Sir Walter, "Indeed, sir, I have not the least intention of dancing. I entreat you not to suppose that I moved this way in order to beg for a partner."`,
      `Mr. Varrow, with grave propriety, requested to be allowed the honour of her hand, but in vain. Liesel was determined; nor did Sir Walter at all shake her purpose by his attempt at persuasion. She looked archly, and turned away.`,
      `Her resistance had not injured her with the gentleman, and he was thinking of her with some complacency, when thus accosted by Miss Ashby: "I can guess the subject of your reverie. You are considering how insupportable it would be to pass many evenings in this manner, in such society."`,
      `"Your conjecture is totally wrong, I assure you. My mind was more agreeably engaged. I have been meditating on the very great pleasure which a pair of fine eyes in the face of a pretty woman can bestow."`,
      `Miss Ashby immediately fixed her eyes on his face, and desired he would tell her what lady had the credit of inspiring such reflections. Mr. Varrow replied with great intrepidity, "Miss Liesel Harrow."`,
      `"Miss Liesel Harrow!" repeated Miss Ashby. "I am all astonishment. How long has she been such a favourite? And pray, when am I to wish you joy?"`,
      `"That is exactly the question which I expected you to ask. A lady's imagination is very rapid; it jumps from admiration to love, from love to matrimony, in a moment."`
    ]
  },
  {
    id: 's05',
    chapter: 5,
    title: 'The ball at Thornmere',
    source: 'scene',
    details: { place: 'thornmere', year: 1811, time: 'November' },
    paragraphs: [
      `Till Liesel entered the drawing-room at Thornmere, and looked in vain for Mr. Dunmore among the cluster of red coats there assembled, a doubt of his being present had never occurred to her. She had dressed with more than usual care, and prepared in the highest spirits for the conquest of all that remained unsubdued of his heart, trusting that it was not more than might be won in the course of the evening.`,
      `Mr. Dunmore was the son of the late steward at Greyhallow, though he seldom said so. His friend Mr. Rook, to whom Lottie eagerly applied, told them that Mr. Dunmore had been obliged to go to town on business the day before, and was not yet returned; adding, with a significant smile, "I do not imagine his business would have called him away just now, if he had not wished to avoid a certain gentleman here."`,
      `This part of his intelligence, though unheard by Lottie, was caught by Liesel; and, as it assured her that Mr. Varrow was not less answerable for Mr. Dunmore's absence than if her first surmise had been just, every feeling of displeasure against the former was so sharpened by immediate disappointment, that she could hardly reply with tolerable civility to the polite inquiries which he directly afterwards approached to make.`,
      `She was soon able to speak to Clara Pell, whom she had not seen for a week, and to give her a particular account of all her griefs; and she had scarcely done so, when she found herself suddenly addressed by Mr. Varrow, who took her so much by surprise in his application for her hand, that, without knowing what she did, she accepted him. He walked away again immediately, and she was left to fret over her own want of presence of mind.`,
      `"I dare say you will find him very agreeable," said Clara, by way of consolation.`,
      `"Heaven forbid! That would be the greatest misfortune of all! To find a man agreeable whom one is determined to hate! Do not wish me such an evil."`,
      `When the dancing recommenced, however, and Mr. Varrow approached to claim her hand, Clara could not help cautioning her in a whisper not to be a simpleton, and allow her fancy for Dunmore to make her appear unpleasant in the eyes of a man ten times his consequence. Liesel made no answer, and took her place in the set.`,
      `They stood for some time without speaking a word; and she began to imagine that their silence was to last through the two dances, till, suddenly fancying that it would be the greater punishment to her partner to oblige him to talk, she made some slight observation on the dance. He replied, and was again silent. After a pause of some minutes, she addressed him a second time with, "It is your turn to say something now, Mr. Varrow. I talked about the dance, and you ought to make some sort of remark on the size of the room, or the number of couples."`,
      `He smiled, and assured her that whatever she wished him to say should be said.`,
      `"Very well; that reply will do for the present. Perhaps, by and by, I may observe that private balls are much pleasanter than public ones; but now we may be silent."`,
      `"Do you talk by rule, then, while you are dancing?"`,
      `"Sometimes. One must speak a little, you know. It would look odd to be entirely silent for half an hour together."`,
      `"Are you consulting your own feelings in the present case, or do you imagine that you are gratifying mine?"`,
      `"Both," replied Liesel archly; "for I have always seen a great similarity in the turn of our minds. We are each of an unsocial, taciturn disposition, unwilling to speak, unless we expect to say something that will amaze the whole room."`,
      `"This is no very striking resemblance of your own character, I am sure," said he. "How near it may be to mine, I cannot pretend to say. You think it a faithful portrait, undoubtedly."`,
      `He asked her whether she and her sisters did not very often walk to Callow Cross. She answered in the affirmative; and, unable to resist the temptation, added, "When you met us there the other day, we had just been forming a new acquaintance."`,
      `The effect was immediate. A deeper shade of hauteur overspread his features, but he said not a word. At length he spoke, and in a constrained manner said, "Mr. Dunmore is blessed with such happy manners as may ensure his making friends; whether he may be equally capable of retaining them is less certain."`,
      `"He has been so unlucky as to lose your friendship," replied Liesel with emphasis, "and in a manner which he is likely to suffer from all his life."`,
      `At that moment Sir Walter Pell appeared close to them, meaning to pass through the set to the other side of the room; but, on perceiving Mr. Varrow, he stopped with a bow of superior courtesy to compliment him on his dancing and his partner. "Such very superior dancing is not often seen. It is evident that you belong to the first circles. I hope to have this pleasure often repeated, especially when a certain desirable event, my dear Miss Liesel," glancing at her sister and Mr. Ashby, "shall take place."`,
      `They had not long separated when Miss Ashby came towards her, and with an expression of civil disdain thus accosted her: "So, Miss Liesel, I hear you are quite delighted with Mr. Dunmore! Let me recommend you, however, as a friend, not to give implicit confidence to all his assertions; for as to Mr. Varrow's using him ill, it is perfectly false. Considering his descent, one could not expect much better."`,
      `"His guilt and his descent appear, by your account, to be the same," said Liesel angrily.`,
      `Johanna met her with a smile of such sweet complacency, a glow of such happy expression, as sufficiently marked how well she was satisfied with the occurrences of the evening. "I have not forgotten him," said Johanna, when Liesel asked what she had learnt of Mr. Dunmore; "but I have nothing satisfactory to tell you. Mr. Ashby does not know the whole of his history, and is quite ignorant of the circumstances which have principally offended Mr. Varrow; but he will vouch for the good conduct, the probity and honour of his friend."`,
      `Then Mr. Pruett came up to them, and told her with great exultation that he had just been so fortunate as to make an important discovery: that there was now in the room a near relation of his patroness, Lady Agatha Strand. He was determined to introduce himself to Mr. Varrow, and no entreaty of Liesel's could stop him; and Mr. Varrow eyed him with unrestrained wonder, replied with an air of distant civility, and moved another way.`,
      `"Lady Agatha Strand's nephew!" Mr. Pruett had exclaimed. "I shall entreat his pardon for not having done it earlier. It will be in my power to assure him that her ladyship was quite well yesterday se'nnight."`,
      `At supper Mrs. Harrow talked freely, openly, and of nothing else but her expectation that Johanna would soon be married to Mr. Ashby. "It is a great comfort to think how fond his two sisters are of Johanna," said she to Lady Pell, loud enough to be heard across the table, "and how near Thornmere is to Wexley, and how rich he is. It will be a fine thing for the younger girls, too, for Johanna's marrying so greatly must throw them in the way of other rich men."`,
      `Liesel blushed and blushed again with shame and vexation, for she could see that Mr. Varrow heard every word.`
    ]
  },
  {
    id: 'h01',
    chapter: 6,
    title: 'The morning room',
    source: 'scene',
    details: { pov: 'liesel', place: 'wexley', year: 1811, time: 'December' },
    paragraphs: [
      `Clara Pell called at Wexley on the Thursday, and found Lise alone in the morning room with a basket of mending.`,
      `The two women sat close to the window, where the light was best. She had green eyes, and in that light they looked almost gold.`,
      `Outside, the lane was white with the first frost, and the boy who brought the post had left the gate open again. Mrs. Harrow had taken Bel and Lottie to Callow Cross to look at ribbons, and the house was quieter than it had been for a month.`,
      `“You have heard that Mr. Ashby has gone to town,” said Clara. “Celia Ashby writes that he will not come back before the spring.”`,
      `“Johanna will not believe it,” said Lise. “She thinks the best of everybody, and of Celia most of all.”`,
      `Lise did not say what she thought herself. She knew Celia Ashby’s letters: they were long, and kind, and every third line of them meant something else.`,
      `Clara Pell was seven-and-twenty, and had long ago stopped expecting anybody to ask her to dance twice. She threaded her needle and said nothing for a while.`,
      `Lise put down the shirt she was mending. She remembered her mother’s red hair, and how Mrs. Harrow had once laughed at a ball until she cried. It seemed a long time ago now, and a very different house.`,
      `“Mr. Varrow called yesterday,” Clara said at last. “He asked after you, and after Johanna, and then he stood at the window for a quarter of an hour and said nothing at all.”`,
      `“Then he may go on asking,” said Lise, and picked up the shirt again.`,
      `When Clara had gone, Lise sat on alone until the light failed, and the mending lay forgotten in her lap.`
    ]
  },
  {
    id: 'h02',
    chapter: 7,
    title: 'The Captain',
    source: 'scene',
    details: { pov: 'liesel', place: 'callow-cross', year: 1811, time: 'December, evening' },
    paragraphs: [
      `The Bell at Callow Cross was full of officers that evening, and Lise, waiting with her aunt for the carriage, could not help watching them.`,
      `Mrs. Pocock had a great deal to say about each of them, and said it. This one was a younger son, and that one was in debt, and the tall one by the window had been crossed in love at Gullhaven and had never been the same since.`,
      `Nobody there called the man by the fire anything but the Captain. Everyone in the taproom knew that the Captain had a long white scar across his jaw, and nobody asked how he had come by it.`,
      `The Captain’s eyes were not blue, whatever the younger girls of Callow Cross liked to say of them. They were the colour of wet slate, and just now they were watching the door.`,
      `Mr. Dunmore came across the room with his hat in his hand and bowed to them both. He was charming about the weather and charming about the militia, and at last, without being asked, he spoke of his family.`,
      `“My father was a clergyman in Elsdale, God rest him,” said Mr. Dunmore, “and he left me nothing but his good name.”`,
      `“A very good thing to be left,” said Mrs. Pocock warmly.`,
      `Lise said nothing. She had heard another account of his father at Thornmere, and she did not know which to believe. She watched the man by the fire instead, who had turned his head at Mr. Dunmore’s voice and was looking at him as a man looks at a horse he once sold and is glad to have sold.`,
      `When the carriage came, the Captain rose, nodded once to the room, and went out into the rain without his hat.`,
      `“Who is he?” Lise asked as they drove home.`,
      `“Nobody knows,” said Mrs. Pocock, with deep satisfaction. “That is the charm of him.”`
    ]
  },
  {
    id: 'h03',
    chapter: 8,
    title: "Harrow's temper",
    source: 'scene',
    details: { pov: 'johanna', place: 'wexley', year: 1811, time: 'December, morning' },
    paragraphs: [
      `Mr. and Mrs. Harrow came down to breakfast together, which was rare, and sat at either end of the table, which was not.`,
      `Harrow’s temper was short that morning, and the toast was cold.`,
      `“There is a letter from Thornmere,” said Mrs. Harrow. “Old Hobb is gone.”`,
      `Old Hobb had kept the lodge gate at Thornmere for forty years. He died in the night, in his chair by the lodge fire, with his pipe still warm in his hand.`,
      `“Gone where?” said Mr. Harrow, without looking up from his paper.`,
      `“Gone, Mr. Harrow! Dead! How can you be so unfeeling, when he opened that gate to us a hundred times?”`,
      `Johanna was sorry for it. When they were children he had kept a sugar plum in his coat for whichever of them reached the gate first, and it had almost always been Lottie.`,
      `She looked down the table at her father, who had put down his paper after all, and at her mother, who was crying a little into her tea, and she thought that neither of them would ever say what they felt in front of the other.`,
      `Mr. Harrow said nothing more until the cloth was drawn. Then he said that he would ride over to Thornmere himself in the afternoon, and Mrs. Harrow, who had expected him to say something unkind, did not know what to do with her handkerchief.`
    ]
  },
  {
    id: 'h04',
    chapter: 9,
    title: "Bel's news",
    source: 'scene',
    details: { pov: 'clara', place: 'pell-house', year: 1811, time: 'December' },
    paragraphs: [
      `Bel Harrow came to Pell House on the Saturday with her bonnet askew and her cheeks very pink.`,
      `She would not sit down, and she would not take tea, and she walked twice round the parlour before she would say anything at all.`,
      `“Lottie is to marry Mr. Dunmore,” said Bel, “but you must not say a word of it to anybody, Clara, for nobody is supposed to know.”`,
      `“Then why do you tell me?” said Clara.`,
      `“Because I shall burst if I do not tell somebody, and you are the only person in the county who never repeats anything.”`,
      `Clara promised. She thought it a very bad match and a worse secret, and she wondered how long a girl of Lottie’s temper could keep it.`,
      `When Bel had gone, Clara sat a long while by the parlour fire, turning the news over, and did not mention it even to her mother.`,
      `Lady Pell came in a little later and asked what Bel Harrow had wanted, and Clara said that she had wanted to borrow a pattern for a bonnet, which was very nearly true.`
    ]
  },
  {
    id: 'h05',
    chapter: 10,
    title: 'Behind the door',
    source: 'scene',
    details: { pov: 'liesel', place: 'wexley', year: 1811, time: 'December' },
    paragraphs: [
      `On the Monday, Lise came up the back stairs with a pile of clean linen and stopped outside the door of the room her younger sisters shared.`,
      `Through the door she heard Lottie’s voice, low and quick.`,
      `“Bel, you must swear not to tell,” said Lottie. “Mr. Dunmore and I are engaged. Nobody knows but you, and nobody is to know until he has his commission.”`,
      `“I swear it,” said Bel. “Oh, Lottie! Engaged! Does he love you very much?”`,
      `“Of course he does. He says I am the only girl in the county with any spirit.”`,
      `Lise stood very still on the landing, the linen growing heavy in her arms. She had overheard every word, and she wished with all her heart that she had not.`,
      `She thought of what Mr. Varrow had not said at the ball, and of what Miss Ashby had said instead, and of Lottie, who was not yet sixteen.`,
      `She went down again without a sound and put the linen away in the wrong press, and did not notice until the evening.`,
      `At dinner Lottie was all smiles, and Bel would not meet anybody’s eye.`
    ]
  },
  {
    id: 'h06',
    chapter: 11,
    title: 'The dream',
    source: 'scene',
    details: { pov: 'liesel', place: 'wexley', year: 1811, time: 'December, night' },
    paragraphs: [
      `That night Lise dreamed of the churchyard at Wexley.`,
      `In the dream, Johanna was dead, and the whole family stood about a narrow grave in the rain while Mr. Varrow read the service in a voice like a stranger’s.`,
      `Lottie was not there. Nobody in the dream seemed to notice it, and when Lise tried to ask, the words came out as the cawing of the rooks in the elms.`,
      `She woke with her heart pounding. Through the wall she could hear Johanna breathing softly in her sleep, and she lay listening to it until the sky grew light.`,
      `At breakfast Johanna asked whether she had slept, and Lise said that she had slept very well.`,
      `All that day the dream stayed with her, as dreams do, like a smell of smoke in a room after the fire is out. She watched Johanna at her needlework and at the piano and at dinner, and was ashamed of herself for watching.`
    ]
  },
  {
    id: 'h07',
    chapter: 12,
    title: 'The walk to Callow Cross',
    source: 'scene',
    details: { pov: 'liesel', place: 'callow-cross', year: 1811, time: 'December' },
    paragraphs: [
      `On the Wednesday the sisters walked to Callow Cross, because Johanna wanted thread and Lise wanted air.`,
      `The road was hard with frost, and the hedges were full of fieldfares. Johanna walked quickly, with her hands in her muff, and talked of everything except Thornmere.`,
      `Johanna Harrow was the gentlest of the four sisters, and the most stubborn when it mattered.`,
      `“They are saying in Callow Cross that Mr. Varrow refused a living to Mr. Dunmore out of spite,” said Lise. “Mrs. Pocock had it from the curate’s wife.”`,
      `“Then Mrs. Pocock had it wrong,” said Johanna. “Mr. Ashby says that Mr. Varrow is the most generous man he knows.”`,
      `It was said in the town that Mr. Varrow had once fought a duel in Elsdale, though nobody could say with whom, or why, or which of them had been hurt.`,
      `“If Mr. Ashby came back tomorrow,” said Lise, “you would be the happiest woman in England, and you would not say so to a living soul.”`,
      `Johanna only walked faster, and Lise was sorry she had said it.`,
      `In the draper’s window there was a bonnet trimmed with cherry ribbon, and Lise stood looking at it until Johanna laughed at her and pulled her inside out of the cold.`,
      `On the way home they passed the Captain on the bridge. He lifted his hat to them without a word, and Johanna asked who he was, and Lise found that she could not tell her.`
    ]
  },
  {
    id: 'h08',
    chapter: 13,
    title: 'The letter',
    source: 'scene',
    details: { pov: 'johanna', place: 'wexley', year: 1812, time: 'March' },
    paragraphs: [
      `In March a letter came from Lottie, who was staying with friends of Mrs. Pocock’s at Gullhaven, and Johanna opened it at the breakfast table because it was addressed to her.`,
      `Johanna was two-and-twenty that spring, and had learnt to read bad news without changing countenance.`,
      `She read it once quickly and once slowly. Then she folded it very small and put it in her pocket, and finished her tea, and nobody noticed anything at all.`,
      `“Dearest Jo, you will laugh when you hear where I am going, and Mr. Dunmore says you must not be cross. We are engaged, and have been since before Christmas, and Bel has known all along.”`,
      `Afterwards Johanna sat in her room with the letter open on her knee. She understood now why Bel had been so quiet all the winter, and why Lise had looked at Lottie so strangely whenever Mr. Dunmore was named.`,
      `She did not tell her mother. She wrote instead to Mr. Ashby, though she had not written to him since the autumn, and asked him plainly what he knew of Mr. Dunmore.`,
      `His answer came in four days, and it was longer than any letter he had ever written her, and kinder; and at the end of it he said that he was coming back to Thornmere.`
    ]
  },
  {
    id: 'h09',
    chapter: 14,
    title: 'Three winters later',
    source: 'scene',
    details: { pov: 'liesel', place: 'thornmere', year: 1814, time: 'January' },
    paragraphs: [
      `Three winters later, Lise came back to Thornmere as a guest, and the house had hardly changed at all.`,
      `Hobb opened the lodge gate for them and touched his hat as the carriage went through.`,
      `Mr. Varrow was waiting on the steps. Varrow’s brown eyes followed her as she climbed down, and she found that she did not mind it.`,
      `Lottie was eighteen now, and married, and nobody at Wexley spoke of how.`,
      `Johanna and Mr. Ashby had been married two years. Ashby had grown a little stouter, and laughed as easily as ever, and Johanna laughed with him.`,
      `“You will find us very dull,” said Ashby, handing her into the hall. “We do nothing but walk and eat and quarrel about the roof.”`,
      `“Then I shall be very happy,” said Lise, and meant it.`,
      `At dinner Mr. Varrow sat beside her and talked, for once, as if talking were a pleasure and not a duty. He asked after her father’s books and her mother’s nerves, and listened to the answers.`,
      `Afterwards, when the others had gone up, she stood at the long window and looked down the drive to the lodge, where a single light was burning.`,
      `Later, Clara came to dine with a basket of winter pears, and talked of nothing but her hens, and Lise laughed for the first time in a long while.`
    ]
  },
  {
    id: 'h10',
    chapter: 14,
    title: 'Three winters later (earlier draft)',
    source: 'inactiveDraft',
    details: { pov: 'liesel', place: 'thornmere', year: 1814, time: 'January' },
    paragraphs: [
      `Three winters later, Lise came back to Thornmere alone, and the house was shut up and cold.`,
      `Varrow’s blue eyes did not look at her once. Johanna had died of a fever the winter before, and Mr. Ashby had gone abroad and never written.`,
      `The lodge stood empty. Nobody had kept the gate since old Hobb went, and the hinges had rusted shut.`,
      `Lise walked through the empty rooms and wished she had never come.`
    ]
  },
  {
    id: 'h11',
    chapter: 15,
    title: 'What if she ran',
    source: 'ideaScene',
    details: { pov: 'liesel' },
    paragraphs: [
      `Idea: Lise runs away to Elsdale with the Captain before the ball.`,
      `In this version Lise has blue eyes and no sisters, and Mr. Harrow has died in the first chapter, so the house goes to Mr. Pruett at once.`,
      `The Captain turns out to be Mr. Varrow’s cousin. Maybe he is the one who sold Mr. Dunmore his commission?`
    ]
  },
  {
    id: 'h12',
    chapter: 16,
    title: 'Cut: the letter from town',
    source: 'excludedScene',
    paragraphs: [
      `Mr. Ashby wrote to Johanna from town. His letter said that he was engaged to Celia’s friend, Miss Daventry, and would not return to Thornmere at all.`,
      `Johanna read it twice and burned it. Clara Pell married Mr. Pruett in the spring, and nobody at Wexley was surprised.`
    ]
  }
]

/** One scene by id; throws for an id the book does not have (a label error). */
export function testBookScene(id: string): TestBookScene {
  const scene = TEST_BOOK.find((candidate) => candidate.id === id)
  if (scene === undefined) throw new Error(`The test book has no scene ${id}`)
  return scene
}
