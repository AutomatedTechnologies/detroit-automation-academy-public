/* Voter guide data — sourced from the Sept 25, 2026 deep-research pass.
   Every claim below comes from the research report; gaps are marked, not filled.
   Full source list: research_notes/michigan-2026-general-election-detroit-20260925-1341/notes/sources.md
   Oct 3, 2026 addition: museum-authority millage ballot question, researched
   from the campaign site, county documents, and press coverage (see sources). */
const GUIDE = {
  updated: "October 3, 2026",
  electionDay: "Tuesday, November 3, 2026",
  races: [
    {
      id: "governor",
      title: "Governor of Michigan",
      voteFor: "Vote for 1",
      context: "Open seat — Gov. Gretchen Whitmer is term-limited. Four-year term. Nominees were set in the August 4 primary; third-party and independent candidates were certified through conventions and filings. Former Detroit Mayor Mike Duggan ended his independent bid in May 2026 and joined the Honigman law firm that August — he will not appear on the ballot.",
      compare: {
        issues: [
          { q: "Abortion", stances: {
            "Jocelyn Benson": "Supports abortion rights",
            "John James": "Describes his platform as defending the unborn", } },
          { q: "Elections & voting", stances: {
            "Jocelyn Benson": "Expand ballot access; opposes new voter-ID requirements",
            "John James": "Supports photo ID and proof-of-citizenship voting requirements", } },
          { q: "Economy", stances: {
            "Jocelyn Benson": "Corporate accountability; cut everyday costs",
            "John James": "\"Michigan first\" manufacturing growth", } },
          { q: "Health care", stances: {
            "Jocelyn Benson": "Lower prescription drug and care costs",
            "John James": "Price transparency, direct primary care, telehealth; scrutiny of hospital consolidation and insurers", } },
          { q: "Education", stances: {
            "Jocelyn Benson": "Competing education proposals (see platform comparison)",
            "John James": "Greater parental involvement in schools", } },
          { q: "Guns", stances: {
            "Jocelyn Benson": "Supports gun-safety reforms",
            "John James": "Supports Constitutional Carry; opposes 'red flag' laws (per Great Lakes Gun Rights survey)", } }
        ]
      },
      candidates: [
        {
          name: "Jocelyn Benson",
          party: "Democratic",
          nomination: "Won the August 4 Democratic primary with 83.2% against Genesee County Sheriff Chris Swanson. Running mate: State Sen. Winnie Brinks (first female Senate majority leader; in the legislature since 2013).",
          platform: [
            "Abortion rights, democracy protection, gun-safety reforms, corporate accountability",
            "Lowering health-care and prescription costs; education and housing affordability proposals"
          ],
          record: [
            "Michigan Secretary of State since 2019 — expanded ballot access and election-security measures",
            "Repeated clashes with House Republicans over election administration"
          ],
          votes: "Has not held legislative office — no legislative voting record. Administrative record is as Secretary of State.",
          sources: [
            ["2026 Michigan gubernatorial election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_gubernatorial_election"],
            ["Benson vs. James platform comparison — Michigan Independent", "https://michiganindependent.com/politics/michigan-governor-candidates-offer-competing-proposals-on-healthcare-and-education"]
          ]
        },
        {
          name: "John James",
          party: "Republican",
          nomination: "Won the August 4 Republican primary with 50.1% against Perry Johnson. Running mate: State Rep. Jay DeBoyer (House Oversight chair; St. Clair city clerk for 12 years; supports photo ID and proof-of-citizenship voting rules).",
          platform: [
            "\"Michigan first\" manufacturing agenda; greater parental involvement in schools",
            "Describes platform as defending the unborn",
            "Supports photo ID and proof-of-citizenship voting requirements",
            "\"Michigan Family Health And Freedom Plan\": price transparency, direct primary care, telehealth to lower costs (per campaign site)"
          ],
          endorsements: ["Endorsed by Donald Trump (June 2026)"],
          record: [
            "U.S. Representative for MI-10 since 2023 (serving second term)",
            "U.S. Army veteran; business background before Congress"
          ],
          votes: "U.S. House roll calls (via congress.gov): Aye on H.R. 8070, FY2025 NDAA (passed 217-199, Jun 2024); Yea on H.R. 1919, Anti-CBDC Surveillance State Act (passed 219-210, Jul 2025); Aye on his own amendment H.Amdt.996 to H.R. 8070 (agreed 272-144).",
          sources: [
            ["2026 Michigan gubernatorial election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_gubernatorial_election"],
            ["Benson vs. James platform comparison — Michigan Independent", "https://michiganindependent.com/politics/michigan-governor-candidates-offer-competing-proposals-on-healthcare-and-education"],
            ["DeBoyer pick — Detroit Free Press", "https://www.freep.com/story/news/politics/2026/08/13/john-james-lieutenant-governor-michigan-jay-deboyer/91283896007/"],
            ["John James voting record — congress.gov", "https://www.congress.gov/member/john-james/J000307"],
            ["James campaign — Freedom Agenda", "https://johnjamesmi.com/freedom-agenda/"],
            ["Trump endorsement — WDIV", "https://gmg-wdiv-prod.cdn.arcpublishing.com/news/local/2026/06/23/aric-nesbitt-drops-out-of-michigan-governor-race-endorses-john-james/"],
            ["James on health care — Detroit Free Press", "https://www.freep.com/story/opinion/editorials/2026/06/30/free-press-endorsement-gubernatorial-primary-gop-primary-john-james-perry-johson-mike-cox/90505965007/"]
          ]
        },
        {
          name: "Douglas Campbell", party: "Green",
          nomination: "Certified for the general ballot (convention nomination).",
          nodata: true,
          sources: [["Governor's race ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/governor-of-michigan-76735"]]
        },
        {
          name: "Anthony Hudson", party: "Libertarian",
          nomination: "Certified for the general ballot (convention nomination).",
          platform: [
            "\"Removing the state income tax would put more money back into the pockets of Michigan families and businesses\"",
            "\"Transitioning from no-fault to at-fault auto insurance would lower premiums for Michigan drivers\"",
            "\"I will write an executive order to remove Michigan from the Flock Camera Surveillance Program\"",
            "\"Issue a 2 year statewide moratorium for data centers and solar farms\""
          ],
          sources: [
            ["Anthony Hudson campaign — policies", "https://electanthonyhudson.com/policies/"],
            ["Governor's race ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/governor-of-michigan-76735"]
          ]
        },
        {
          name: "Donna Brandenburg", party: "U.S. Taxpayers",
          nomination: "Certified for the general ballot (convention nomination).",
          platform: [
            "\"I'm a Constitutional Conservative, an unapologetic Christian, and believe that we were given unalienable rights by God, which are guaranteed by the Constitution\"",
            "\"We need to go back to simpler times, deregulate, decentralize and put Michigan in order\""
          ],
          flag: "Platform quotes are from her campaign site, which dates to her earlier run for governor and remains live; no separate 2026 platform page was found.",
          sources: [
            ["Donna Brandenburg campaign site", "https://donna4mi.com/donna-brandenburg-for-governor.html"],
            ["Governor's race ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/governor-of-michigan-76735"]
          ]
        },
        {
          name: "Evan Space", party: "Independent (write-in)",
          nomination: "Filed as an independent write-in candidate.",
          platform: [
            "\"Under Space and his administration, we will eliminate Michigan business tax\"",
            "\"Evan Space thinks it is time for Michigan to move forward and create a 51st statehood for the Upper Peninsula of Michigan\"",
            "\"Space will keep the project open and moving forward\" (on the Enbridge Line 5 tunnel, plus a secondary tunnel for public transit)",
            "\"It is time for a real governor to see the future\" (on bringing space launch sites to Michigan)"
          ],
          sources: [
            ["Evan Space campaign site", "https://space4governor.com/"],
            ["Governor's race ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/governor-of-michigan-76735"]
          ]
        }
      ]
    },
    {
      id: "senate",
      title: "U.S. Senate — Michigan",
      voteFor: "Vote for 1",
      context: "Open seat — Sen. Gary Peters is retiring when his term ends in January 2027. Six-year term. Widely rated a toss-up; control of the Senate may run through Michigan. First debate October 8, 2026; second debate October 21 on WXYZ-TV (Channel 7).",
      compare: {
        issues: [
          { q: "Health care", stances: {
            "Abdul El-Sayed": "Medicare for All",
            "Mike Rogers": "Opposes the ACA; 2026 plan: expand TrumpRx bulk drug-buying, price transparency, public claim-denial rates" } },
          { q: "Immigration", stances: {
            "Abdul El-Sayed": "Abolish ICE; enforcement through CBP instead",
            "Mike Rogers": "Complete the border wall; reinstate Remain in Mexico; deport criminal immigrants" } },
          { q: "Abortion", stances: {
            "Abdul El-Sayed": "Supports abortion rights",
            "Mike Rogers": "Supports abortion restrictions" } },
          { q: "Guns", stances: {
            "Abdul El-Sayed": "Supports gun control",
            "Mike Rogers": "Supports gun rights" } },
          { q: "Economy", stances: {
            "Abdul El-Sayed": "$15 minimum wage; tax the wealthy",
            "Mike Rogers": "Cut taxes (no tax on tips/overtime/Social Security); expand child tax credit; end EV mandate; reciprocal tariffs" } },
          { q: "Energy & climate", stances: {
            "Abdul El-Sayed": "Green New Deal",
            "Mike Rogers": "Opposes EV mandates" } },
          { q: "Foreign policy", stances: {
            "Abdul El-Sayed": "Opposes U.S. military aid to Israel; supports BDS",
            "Mike Rogers": "Supports Israel's right to defend itself; backs lend-lease for Ukraine; names Iran principal adversary" } },
          { q: "Voting rights", stances: {
            "Abdul El-Sayed": "Expand voting rights",
            "Mike Rogers": "Supports the SAVE Act (photo ID + proof-of-citizenship requirements)" } }
        ]
      },
      candidates: [
        {
          name: "Abdul El-Sayed",
          party: "Democratic",
          nomination: "Won the August 4 Democratic primary with 48.5% against Haley Stevens (47.5%); Mallory McMorrow withdrew before the primary.",
          platform: [
            "Medicare for All; Green New Deal; $15 minimum wage",
            "Expand voting rights; gun control; abortion rights",
            "Opposes U.S. military aid to Israel; supports BDS",
            "Abolish ICE; run border enforcement through Customs and Border Protection instead"
          ],
          record: [
            "Former health director for the City of Detroit and for Wayne County",
            "Physician and public-health leader; 2018 Democratic gubernatorial primary candidate"
          ],
          votes: "Has not held legislative office — no legislative voting record.",
          sources: [
            ["2026 U.S. Senate election in Michigan — Wikipedia", "https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Michigan"],
            ["Michigan 2026 U.S. Senate voter guide — MichWomen", "https://michwomen.com/blog/2026-candidates-for-michigan-us-senate"],
            ["Senate & governor race overview — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/08/28/u-s-senate-governor-race-have-all-eyes-on-michigan/91456947007/"],
            ["Oct 8, 2026 Senate debate recap — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/10/08/abdul-el-sayed-mike-rogers-us-senate-debate/92162055007/"],
            ["Oct 8, 2026 Senate debate takeaways — USA Today", "https://www.usatoday.com/story/news/politics/elections/2026/10/08/michigan-senate-debate-takeaways/92160978007/"],
          ]
        },
        {
          name: "Mike Rogers",
          party: "Republican",
          nomination: "Ran unopposed for the Republican nomination.",
          platform: [
            "Complete the border wall; reinstate Remain in Mexico; deport criminal immigrants (his 2024 campaign's words)",
            "Abortion restrictions; gun rights; opposition to EV mandates",
            "Opposes the Affordable Care Act; 2026 health plan: expand TrumpRx bulk drug-buying, mandatory price transparency, public insurer claim-denial rates",
            "Cut taxes (no tax on tips, overtime, or Social Security); expand child tax credit; end the federal EV mandate; reciprocal tariffs"
          ],
          record: [
            "U.S. Representative for Michigan 2001–2015; chaired the House Intelligence Committee",
            "Former FBI special agent; 2024 Republican Senate nominee (lost to Elissa Slotkin)"
          ],
          votes: "Fourteen years in the U.S. House with a full roll-call record, plus a 2024 Senate run. Detailed vote highlights were not extracted in this research pass — see congress.gov for the full record.",
          sources: [
            ["2026 U.S. Senate election in Michigan — Wikipedia", "https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Michigan"],
            ["Senate & governor race overview — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/08/28/u-s-senate-governor-race-have-all-eyes-on-michigan/91456947007/"],
            ["Rogers 2026 campaign — healthcare plan", "http://rogersforsenate.com/news/rogers-announces-healthcare-plan-healthcare-that-works-for-working-families"],
            ["Rogers Oct 2024 op-ed — Washington Reporter", "https://washingtonreporter.news/op-ed-mike-rogers-send-me-to-washington-to-clean-up-the-democrats-mess/"],
            ["2024 Senate debate — Oakland Post", "https://oaklandpostonline.com/51110/politics/rogers-michigan-senate-debate/"],
            ["Senate candidates on health care — WCMU", "https://www.wcmu.org/local-regional-news/2026-09-19/michigans-two-major-party-candidates-for-u-s-senate-offer-differing-ideas-for-health-care"],
            ["Oct 8, 2026 Senate debate recap — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/10/08/abdul-el-sayed-mike-rogers-us-senate-debate/92162055007/"],
            ["Oct 8, 2026 Senate debate takeaways — USA Today", "https://www.usatoday.com/story/news/politics/elections/2026/10/08/michigan-senate-debate-takeaways/92160978007/"],
          ]
        },
        {
          name: "Douglas Marsh", party: "Green",
          nomination: "Certified for the general ballot.",
          platform: [
            "\"I will advocate in the U.S. Senate for a Universal Basic Income of $1,000 per month\"",
            "\"The best way to ensure this is with a single-payer system\" (healthcare)",
            "\"Private equity companies should not own residential property\"",
            "\"We must stop corporations from pilfering our freshwater resources\""
          ],
          sources: [
            ["Douglas Marsh campaign site", "https://www.electmarsh.org/"],
            ["U.S. Senate election in Michigan, 2026 — Ballotpedia", "https://ballotpedia.org/United_States_Senate_election_in_Michigan,_2026"]
          ]
        },
        {
          name: "Lydia Christensen", party: "Libertarian",
          nomination: "Certified for the general ballot.",
          platform: [
            "\"No family should bear the cost of a medical issue, no one should forgo healthcare because of the costs\"",
            "\"All men are created equal and our government should hold that promise true\"",
            "\"Preserving our national forests and clean renewable energy\" (described as a key campaign component)"
          ],
          sources: [
            ["Lydia Christensen — Ballotpedia Candidate Connection survey", "https://ballotpedia.org/Lydia_Christensen"],
            ["U.S. Senate election in Michigan, 2026 — Ballotpedia", "https://ballotpedia.org/United_States_Senate_election_in_Michigan,_2026"]
          ]
        },
        {
          name: "Walter Kristy", party: "Natural Law",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["U.S. Senate election in Michigan, 2026 — Ballotpedia", "https://ballotpedia.org/United_States_Senate_election_in_Michigan,_2026"]]
        },
        {
          name: "Timothy Long", party: "U.S. Taxpayers",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["U.S. Senate election in Michigan, 2026 — Ballotpedia", "https://ballotpedia.org/United_States_Senate_election_in_Michigan,_2026"]]
        }
      ]
    },
    {
      id: "house13",
      title: "U.S. House — District 13",
      voteFor: "Vote for 1",
      context: "Two-year term. The district covers most of Detroit and is rated Safe Democratic. Incumbent Rep. Shri Thanedar lost the August Democratic primary and leaves office in January 2027.",
      candidates: [
        {
          name: "Donavan McKinney",
          party: "Democratic",
          nomination: "Won the August 4 Democratic primary with 51.7% (57,746 votes) against incumbent Shri Thanedar (47.9%, 53,522).",
          platform: [
            "Medicare for All (dental, vision, mental health, reproductive health, abortion care); overturn Citizens United; rejects corporate PAC money (per campaign site)",
            "Green New Deal and 100% clean energy; universal basic income; living wage; universal free pre-K; tuition-free public college and trade school; cancel student loan debt",
            "Codify abortion rights federally; end cash bail and qualified immunity; pathway to citizenship; \"End the military aid and arms that America gives to Israel\""
          ],
          record: [
            "State representative in the Michigan House before running for Congress",
            "In the Michigan House, helped lead introduction of bills to bar monopoly utility corporations and government contractors from political donations (per campaign site)"
          ],
          votes: "Served in the Michigan House — roll-call record available through the Michigan Legislature's official records. Detailed highlights were not extracted in this research pass.",
          sources: [
            ["McKinney campaign — priorities", "https://www.donavanforcongress.com/priorities"],
            ["McKinney beats Thanedar — Detroit Free Press", "https://www.freep.com/story/news/politics/2026/08/05/donavan-mckinney-shri-thanedar-michigan-13th-congressional-district-results/91076768007/"],
            ["Certified primary results — Michigan Republican Primary", "http://michiganrepublicanprimary.com/2026-michigan-primary-election-results/"],
            ["2026 House elections in Michigan — Wikipedia", "https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections_in_Michigan"]
          ]
        },
        {
          name: "T.P. Nykoriak",
          party: "Republican",
          nomination: "Ran effectively unopposed in the Republican primary (99.5%, 18,478 votes).",
          platform: [
            "Marijuana decriminalization; ending qualified immunity; protecting welfare programs"
          ],
          record: ["Frequent candidate for office in the region"],
          votes: "Has not held legislative office — no legislative voting record.",
          flag: "Platform details come from a single local report of his campaign website — treat as unverified. One aggregator also alleged a 2016 conviction; we found no second source and do not repeat it as fact.",
          sources: [
            ["Candidate platform report — Albia News", "https://www.albianews.com/news/national/article_8b28e695-faad-550d-a968-e13c9a71dae3.html"],
            ["MI-13 primary ballot — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/08/03/mi-us-house-candidates-primary-ballot/91128857007/"]
          ]
        },
        {
          name: "Maurice Morton",
          party: "Independent",
          nomination: "Filed a Statement of Candidacy with the FEC as an independent (Dec 18, 2025); member of the Independent Candidate Network.",
          nodata: true,
          sources: [
            ["FEC Statement of Candidacy", "https://docquery.fec.gov/cgi-bin/forms/H4MI14166/1928940"],
            ["Independent filings — MIRS News", "http://home.mirs.news/post/nine-candidates-running-as-independent-for-november-in-michigan"]
          ],
          flag: "An additional independent filing (Shelby Campbell) was reported for MI-13 — ballot status unconfirmed."
        }
      ]
    },
    {
      id: "sos",
      title: "Michigan Secretary of State",
      voteFor: "Vote for 1",
      context: "Open seat — Jocelyn Benson is term-limited and running for governor. Four-year term. Michigan's top election official. Nominees were chosen at party conventions, not the primary.",
      compare: {
        issues: [
          { q: "Proof of citizenship to vote", stances: {
            "Garlin Gilchrist II": "Opposes requiring it",
            "Anthony Forlini": "Supports requiring it" } },
          { q: "Election security", stances: {
            "Garlin Gilchrist II": "Emphasizes current safeguards and access",
            "Anthony Forlini": "Emphasizes tighter security rules" } }
        ]
      },
      candidates: [
        {
          name: "Garlin Gilchrist II",
          party: "Democratic",
          nomination: "Nominated at the August Democratic convention. Dropped his own bid for governor to run for this office.",
          platform: [
            "Opposes proof-of-citizenship requirements to vote",
            "Priorities: election security and maintaining ballot access (per Votebeat interviews)"
          ],
          record: [
            "Lieutenant Governor of Michigan since 2019",
            "Technology and public-policy background before statewide office"
          ],
          votes: "Has not held legislative office — no legislative voting record.",
          sources: [
            ["2026 Michigan Secretary of State election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Secretary_of_State_election"],
            ["Where the candidates stand — WCMU/Votebeat", "https://www.wcmu.org/local-regional-news/2026-03-03/michigan-will-pick-a-new-top-election-official-this-year-heres-where-the-candidates-stand"]
          ]
        },
        {
          name: "Anthony Forlini",
          party: "Republican",
          nomination: "Formally nominated at the August Republican convention.",
          platform: [
            "Supports proof-of-citizenship and photo ID voting requirements",
            "Priorities: election security and administrative overhaul (per Votebeat interviews)"
          ],
          record: ["Nominated through the party convention process; background details not extracted in this research pass"],
          votes: "Legislative voting record not established in this research pass.",
          sources: [
            ["2026 Michigan Secretary of State election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Secretary_of_State_election"],
            ["Where the candidates stand — WCMU/Votebeat", "https://www.wcmu.org/local-regional-news/2026-03-03/michigan-will-pick-a-new-top-election-official-this-year-heres-where-the-candidates-stand"],
            ["GOP nominating convention — The Midwesterner", "https://www.themidwesterner.news/2026/08/michigan-republicans-unite-at-nominating-convention-unanimously-back-deboyer-for-lg-forlini-for-sos-lloyd-for-ag/"]
          ]
        },
        {
          name: "Christine Sloan", party: "Libertarian",
          nomination: "Certified for the general ballot.",
          platform: [
            "\"Running for Michigan Secretary of State to put the office back where it belongs: serving citizens, not political interests\"",
            "\"Ensuring every qualified voter can cast a ballot — and that every lawful ballot is counted\"",
            "\"Government should do less. Your rights are not negotiable\"",
            "\"Your data, your movements, your life — not the government's business\""
          ],
          sources: [
            ["Christine Sloan campaign — about", "https://votechristinesloan.com/about/"],
            ["Christine Sloan campaign — issues", "https://votechristinesloan.com/issues/"],
            ["2026 Michigan Secretary of State election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Secretary_of_State_election"]
          ]
        },
        {
          name: "Eric Borregard", party: "Green",
          nomination: "Certified for the general ballot.",
          platform: [
            "\"Michigan should be fighting for more democratic freedoms and not voting Democratic & Republican for less\"",
            "\"When people vote for the duopoly's big corporate money candidates, civic engagement and democratic process are automatically lost\"",
            "\"The debates are now bought and paid for by large media corporations with their own private agendas for your tax dollars\""
          ],
          sources: [
            ["Eric Borregard campaign site", "https://www.ericborregard4michsos.org/"],
            ["2026 Michigan Secretary of State election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Secretary_of_State_election"]
          ]
        },
        {
          name: "Scott Aughney", party: "U.S. Taxpayers",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["2026 Michigan Secretary of State election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Secretary_of_State_election"]]
        }
      ]
    },
    {
      id: "ag",
      title: "Michigan Attorney General",
      voteFor: "Vote for 1",
      context: "Open seat — Dana Nessel is term-limited. Four-year term. Nominees were chosen at party conventions, not the primary.",
      candidates: [
        {
          name: "Eli Savit",
          party: "Democratic",
          nomination: "Nominated at the April Democratic convention, defeating McDonald and Noakes.",
          platform: [
            "\"I'm running to stand up for the people of the state of Michigan, no matter who is screwing them over\" — priorities include corporate polluters, consumer scams, wage theft, and AI-related fraud",
            "Full platform details in the MichWomen voter guide (linked)"
          ],
          record: [
            "Washtenaw County Prosecutor since 2021 (re-elected 2024); says his office is \"committed to dispensing justice evenhandedly\" — ended cash-bail requests and campaigned on reducing racial and socio-economic inequities in the justice system",
            "Former senior legal counsel for the City of Detroit; clerked for U.S. Supreme Court Justices O'Connor and Ginsburg"
          ],
          votes: "Prosecutor, not legislator — no legislative voting record.",
          sources: [
            ["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"],
            ["Michigan AG race 2026 voter guide — MichWomen", "https://michwomen.com/blog/michigan-attorney-general-race-2026-voter-guide"],
            ["Savit on his record — Detroit Free Press", "https://www.beaconjournal.com/story/news/politics/elections/2025/05/13/washtenaw-county-prosecutor-eli-savit-michigan-attorney-general/83577005007/"]
          ]
        },
        {
          name: "Doug Lloyd",
          party: "Republican",
          nomination: "Endorsed at the March GOP convention with 63% over Kijewski; formally nominated in August.",
          platform: [
            "Public safety as \"the one main focus of government\"; pledges a day-one review of Nessel's federal lawsuits — \"are those lawsuits actually benefiting the citizens of Michigan?\"",
            "Pledges to \"prosecute criminals fairly — without political favor or bias\" and \"stand firmly against political lawfare and weaponized prosecutions\"",
            "Full platform details in the MichWomen voter guide (linked)"
          ],
          record: [
            "Eaton County Prosecuting Attorney since 2013; 30-year career prosecutor (Jackson County prosecutor's office, then Eaton County drug prosecutor)",
            "Launched the J. Sauter Veterans Treatment Court plus Adult Drug Court and Felony Sobriety Court programs"
          ],
          votes: "Prosecutor, not legislator — no legislative voting record.",
          sources: [
            ["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"],
            ["Michigan AG race 2026 voter guide — MichWomen", "https://michwomen.com/blog/michigan-attorney-general-race-2026-voter-guide"],
            ["GOP convention endorsement — The Midwesterner", "https://www.themidwesterner.news/2026/03/michigan-republicans-endorse-anthony-forlini-for-secretary-of-state-doug-lloyd-for-attorney-general/"],
            ["AG candidates on priorities — Planet Detroit", "https://planetdetroit.org/2026/09/michigan-attorney-general-candidates-utility-oversight/"]
          ]
        },
        {
          name: "Jason Dye", party: "Libertarian",
          nomination: "Certified for the general ballot.",
          platform: [
            "\"Tread on Corruption. Defend the Constitution. Follow the Receipts\"",
            "\"Michigan families should not have to fight an anonymous algorithm for medically necessary care\"",
            "\"A denial is not automatically a crime. But paperwork is not immunity\""
          ],
          sources: [
            ["Jason Dye campaign site", "http://dye4ag.com/"],
            ["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"]
          ]
        },
        {
          name: "Jeff Polonowski", party: "Green",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"]]
        },
        {
          name: "John Perry Ludtke Jr.", party: "U.S. Taxpayers",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"]]
        },
        {
          name: "Doug Dern", party: "Natural Law",
          nomination: "Certified for the general ballot.",
          nodata: true,
          sources: [["2026 Michigan Attorney General election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Attorney_General_election"]]
        }
      ],
      flag: "Matt DePerno skipped the GOP convention and was described in August as an unendorsed Republican still in the race; in August 2023 a special prosecutor charged him on four counts tied to the 2020 voting-tabulator breach (undue possession of a voting machine, conspiracy, willful damage) — he pleaded not guilty and the case was still pending per May 2026 reporting (AP; NPR; Detroit Free Press). Whether he qualified for the November ballot is unconfirmed."
    },
    {
      id: "supreme-court",
      title: "Michigan Supreme Court",
      voteFor: "Vote for no more than 2",
      context: "Two of seven seats are on the ballot; eight-year terms. The ballot itself is nonpartisan, but candidates are nominated by party conventions. Democrats currently hold a 6–1 majority on the court.",
      candidates: [
        {
          name: "Megan Cavanagh",
          party: "Democratic-nominated (incumbent)",
          nomination: "Nominated at the Democratic convention.",
          platform: ["Judicial philosophy: see linked coverage"],
          record: [
            "On the court since 2019",
            "Authored the ruling on juvenile life-without-parole sentencing"
          ],
          votes: "Appellate judicial office — no legislative voting record. Opinions are public through the court's official records.",
          sources: [
            ["Michigan Supreme Court elections, 2026 — Ballotpedia", "https://ballotpedia.org/Michigan_Supreme_Court_elections,_2026"],
            ["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"],
            ["State-by-state 2026 supreme court guide — Bolts", "https://boltsmag.org/your-state-by-state-guide-to-the-2026-supreme-court-elections/"]
          ]
        },
        {
          name: "Noah Hood",
          party: "Democratic-nominated (incumbent)",
          nomination: "Nominated at the Democratic convention.",
          platform: ["Judicial philosophy: see linked coverage"],
          record: ["Appointed to the court; no major rulings yet, per court watchers"],
          votes: "Appellate judicial office — no legislative voting record.",
          sources: [
            ["Michigan Supreme Court elections, 2026 — Ballotpedia", "https://ballotpedia.org/Michigan_Supreme_Court_elections,_2026"],
            ["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"]
          ]
        },
        {
          name: "Casandra Morse-Bills",
          party: "Republican-nominated",
          nomination: "Nominated at the Republican convention.",
          platform: ["Describes a judicial-restraint philosophy"],
          record: ["Former prosecuting attorney; Cooley Law School JD"],
          votes: "Judicial office — no legislative voting record.",
          flag: "Sources conflict on her current judgeship — listed as an Oscoda County district judge in one source and a 23rd Circuit judge in others. Unresolved.",
          sources: [
            ["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"],
            ["Morse-Bills background — YouTube", "https://www.youtube.com/watch?v=jZlWanhUIFw"]
          ]
        },
        {
          name: "Michael Warren",
          party: "Republican-nominated",
          nomination: "Nominated at the Republican convention.",
          platform: ["Judicial philosophy: see linked interview"],
          record: [
            "Oakland County judge since 2002 — Business Court and General Criminal Division",
            "Thousands of criminal cases; roughly 400 jury trials; co-founder of Patriot Week"
          ],
          votes: "Judicial office — no legislative voting record.",
          sources: [
            ["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"],
            ["Warren interview — Michigan's Big Show", "https://www.iheart.com/podcast/966-michigans-big-show-28366325/episode/judge-michael-warren-candidate-for-334228583/"]
          ]
        },
        {
          name: "Thomas Howe", party: "U.S. Taxpayers-nominated",
          nomination: "Nominated at the U.S. Taxpayers convention.",
          nodata: true,
          sources: [["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"]]
        },
        {
          name: "Jody White", party: "U.S. Taxpayers-nominated",
          nomination: "Nominated at the U.S. Taxpayers convention.",
          nodata: true,
          sources: [["2026 Michigan Supreme Court election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_Supreme_Court_election"]]
        }
      ]
    },
    {
      id: "sboe",
      title: "State Board of Education",
      voteFor: "Vote for no more than 2",
      context: "Two of eight seats; eight-year terms. The board sets statewide education policy. Nominees were chosen at party conventions.",
      candidates: [
        { name: "Judith Pritchett", party: "Democratic", nomination: "Nominated at the Democratic convention.", platform: ["Positions covered in Bridge Michigan candidate interviews (linked)"], record: [], votes: "Board office — no legislative voting record.", sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"], ["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Tiffany Tilley", party: "Democratic", nomination: "Nominated at the Democratic convention.", platform: ["Positions covered in Bridge Michigan candidate interviews (linked)"], record: [], votes: "Board office — no legislative voting record.", sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"], ["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Terence Collins", party: "Republican", nomination: "Nominated at the Republican convention.", platform: ["Positions covered in Bridge Michigan candidate interviews (linked)"], record: [], votes: "Board office — no legislative voting record.", sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"], ["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Bree Moeggenberg", party: "Republican", nomination: "Nominated at the Republican convention.", platform: ["Positions covered in Bridge Michigan candidate interviews (linked)"], record: [], votes: "Board office — no legislative voting record.", sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"], ["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Charles Essner", party: "Libertarian", nomination: "Certified for the general ballot.", nodata: true, sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"]] },
        { name: "Wissam Charafeddine", party: "Green", nomination: "Certified for the general ballot.", nodata: true, sources: [["2026 Michigan State Board of Education election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_Board_of_Education_election"]] },
        { name: "William Mohr II", party: "U.S. Taxpayers", nomination: "Certified for the general ballot.", nodata: true, sources: [["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Christine Schwartz", party: "U.S. Taxpayers", nomination: "Certified for the general ballot.", nodata: true, sources: [["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Mary Anne Hering", party: "Working Class", nomination: "Certified for the general ballot.", nodata: true, sources: [["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] },
        { name: "Kelli Monroe", party: "Natural Law", nomination: "Certified for the general ballot.", nodata: true, sources: [["SBOE candidate interviews — Bridge Michigan via Muskegon Tribune", "https://muskegontribune.com/who-are-the-michigan-state-board-of-education-candidates-what-to-know/"]] }
      ]
    },
    {
      id: "um-regents",
      title: "University of Michigan Board of Regents",
      voteFor: "Vote for no more than 2",
      context: "Two of eight seats; eight-year terms. The board governs the University of Michigan. Nominees were chosen at party conventions.",
      candidates: [
        {
          name: "Paul Brown", party: "Democratic (incumbent)",
          nomination: "Nominated at the Democratic convention.",
          nodata: true,
          flag: "No biographical or platform details found in this research pass.",
          sources: [["2026 UM Board of Regents election — Wikipedia", "https://en.wikipedia.org/wiki/2026_University_of_Michigan_Board_of_Regents_election"]]
        },
        {
          name: "Amir Makled", party: "Democratic",
          nomination: "Nominated at the Democratic convention, defeating Acker.",
          platform: [
            "Says he \"remains pro-divestment from Israel\" — \"we shouldn't be profiting from entities that are supporting a genocide [and] expanding the military industrial complex\" (his words, via The Michigan Daily)",
            "Stated priorities: tuition, labor, free speech, civil rights (per MLive interview)"
          ],
          record: ["Dearborn-based civil-rights attorney"],
          votes: "Has not held legislative office — no legislative voting record.",
          flag: "The Detroit News reported he shared then deleted posts praising Hezbollah figures and reposting antisemitic content; SEIU withdrew its endorsement after the posts surfaced and Sen. Elissa Slotkin publicly criticized the nomination. Makled says he disavows antisemitism (per MLive).",
          sources: [
            ["2026 UM Board of Regents election — Wikipedia", "https://en.wikipedia.org/wiki/2026_University_of_Michigan_Board_of_Regents_election"],
            ["Makled quotes via The Michigan Daily", "https://www.thecollegefix.com/u-michigan-regent-candidate-deletes-praise-for-hezbollah-antisemitic-remarks/"],
            ["Makled interview via MLive", "http://www.thecollegefix.com/democratic-umich-regents-refuse-comment-on-nominee-who-posted-antisemitic-slurs/"]
          ]
        },
        { name: "Lena Epstein", party: "Republican", nomination: "Nominated at the Republican convention.", nodata: true, sources: [["2026 UM Board of Regents election — Wikipedia", "https://en.wikipedia.org/wiki/2026_University_of_Michigan_Board_of_Regents_election"], ["UM Regents ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/university-of-michigan-board-of-regents"]] },
        { name: "Michael Schostak", party: "Republican", nomination: "Nominated at the Republican convention.", nodata: true, sources: [["2026 UM Board of Regents election — Wikipedia", "https://en.wikipedia.org/wiki/2026_University_of_Michigan_Board_of_Regents_election"], ["UM Regents ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/university-of-michigan-board-of-regents"]] },
        { name: "Andrew Chadderdon", party: "Libertarian", nomination: "Listed \"On the Ballot\" for the general election.", nodata: true, sources: [["UM Regents ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/university-of-michigan-board-of-regents"]] },
        { name: "Kyle Maas", party: "U.S. Taxpayers", nomination: "Filed paperwork; listed \"On the Ballot\" for the general election.", nodata: true, sources: [["2026 UM Board of Regents election — Wikipedia", "https://en.wikipedia.org/wiki/2026_University_of_Michigan_Board_of_Regents_election"], ["UM Regents ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/university-of-michigan-board-of-regents"]] }
      ]
    },
    {
      id: "msu-trustees",
      title: "Michigan State University Board of Trustees",
      voteFor: "Vote for no more than 2",
      context: "Two of eight seats; eight-year terms. Nominees were chosen at party conventions.",
      candidates: [
        {
          name: "Brianna Scott", party: "Democratic (incumbent)",
          nomination: "Nominated at the Democratic convention with 38.21%, defeating State Sen. Sylvia Santana (30.78%). Currently serving a one-year term as board chair.",
          platform: ["Keep working to make MSU affordable for in-state students; act in the university's best interests"],
          record: [
            "Trustee since 2019",
            "Led board initiatives improving the university's response to sexual-assault survivors after the Larry Nassar scandal; supported inclusion programs"
          ],
          votes: "Board office — no legislative voting record.",
          sources: [
            ["Scott, Tebay Zemke net Democratic nomination — The State News", "https://statenews.com/article/2026/04/trustees-scott-tebay-zemke-net-democratic-nomination-for-msu-board"],
            ["2026 MSU Board of Trustees election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_University_Board_of_Trustees_election"]
          ]
        },
        {
          name: "Kelly Tebay Zemke", party: "Democratic (incumbent)",
          nomination: "Nominated at the Democratic convention with 31.01%.",
          platform: ["Emphasizes the reforms made to MSU's handling of sexual-assault cases since the Nassar scandal"],
          record: ["Trustee since 2019; former board chair"],
          votes: "Board office — no legislative voting record.",
          sources: [
            ["Scott, Tebay Zemke net Democratic nomination — The State News", "https://statenews.com/article/2026/04/trustees-scott-tebay-zemke-net-democratic-nomination-for-msu-board"],
            ["2026 MSU Board of Trustees election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_University_Board_of_Trustees_election"]
          ]
        },
        {
          name: "Julie Maday", party: "Republican",
          nomination: "Nominated at the April Republican convention; endorsed by the Michigan Republican Party.",
          platform: [
            "\"Restore stability, accountability, and transparency at Michigan State University\"; supports \"affordable tuition, student well-being, and practical governance that prioritizes academic excellence\" (per Michigan GOP bio)",
            "On tuition: \"Tuition costs are too expensive for a state school… spending is definitely out of control\" — says MSU must cut wasteful spending and \"get back to the basics\" (2024, via Detroit Free Press)"
          ],
          record: [
            "Former Novi city councilwoman (also served on the Planning Commission); Novi resident for 30+ years; UM-Dearborn graduate",
            "2024 Republican nominee for trustee — lost narrowly (her campaign says by about 4,100 votes); mother of two MSU students"
          ],
          votes: "Board office — no legislative voting record.",
          sources: [
            ["2026 MSU Board of Trustees election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_University_Board_of_Trustees_election"],
            ["Maday bio — Michigan GOP", "https://mi.gop/julie-maday/"],
            ["2024 trustee candidates on tuition — Detroit Free Press", "https://www.beaconjournal.com/story/news/local/campus/2024/10/07/michigan-state-university-trustee-candidates-balow-maday-bahar-cook-stallworth/75486620007/"]
          ]
        },
        {
          name: "Roger Victory", party: "Republican",
          nomination: "Nominated at the April Republican convention; endorsed by the Michigan Republican Party.",
          platform: [
            "Pitching an agriculture voice for the land-grant university: MSU \"was founded as an agricultural institution\" and \"deserves an experienced agricultural voice on its Board of Trustees\" (his words, via State Affairs)",
            "Wants MSU's agriculture programs to partner with its medical college and \"be a leader nationally in promoting food and health\""
          ],
          record: [
            "Michigan state senator since 2019 (31st district; previously the 30th); served in the Michigan House 2013–2019; term-limited, not seeking Senate re-election",
            "Farmer — owner/operator of Victory Farms LLC; previously chaired the Senate Appropriations Subcommittee on Agriculture and Rural Development, the channel for MSU AgBioResearch and Extension funding"
          ],
          votes: "Sits in the Michigan Senate — roll-call record available through the Michigan Legislature's official records.",
          sources: [
            ["2026 MSU Board of Trustees election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Michigan_State_University_Board_of_Trustees_election"],
            ["Victory on his trustee bid — State Affairs", "https://cms.stateaffairs.com/tag/sen-roger-victory/"],
            ["Roger Victory — Wikipedia", "https://en.wikipedia.org/wiki/Roger_Victory"]
          ]
        },
        { name: "John Anthony La Pietra", party: "Green", nomination: "Listed on the general-election ballot.", nodata: true, sources: [["Michigan State Board of Regents election, 2026 — Ballotpedia", "https://Ballotpedia.org/Michigan_State_Board_of_Regents_election,_2026"]] }
      ],
      flag: "Libertarians Daniel Patterson and Will White, U.S. Taxpayers candidates Janet and John Sanger, and Working Class candidate Yaz Ozbek filed paperwork — we could not confirm which qualified for the ballot."
    },
    {
      id: "wsu-governors",
      title: "Wayne State University Board of Governors",
      voteFor: "Vote for no more than 2",
      context: "Two of eight seats; eight-year terms. Both current governors whose terms expire (Bryan Barnhill, Anil Kumar) declined to seek renomination. Nominees were chosen at party conventions.",
      candidates: [
        { name: "Shereef Akeel", party: "Democratic", nomination: "Nominated at the Democratic convention.", platform: [], record: ["Civil-rights attorney"], votes: "Has not held legislative office — no legislative voting record.", sources: [["2026 WSU Board of Governors election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Wayne_State_University_Board_of_Governors_election"]] },
        { name: "Richard Mack", party: "Democratic", nomination: "Nominated at the Democratic convention.", platform: [], record: ["Attorney"], votes: "Has not held legislative office — no legislative voting record.", sources: [["2026 WSU Board of Governors election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Wayne_State_University_Board_of_Governors_election"]] },
        { name: "Andy Anuzis", party: "Republican", nomination: "Nominated at the Republican convention.", platform: [], record: ["High-school principal"], votes: "Has not held legislative office — no legislative voting record.", sources: [["2026 WSU Board of Governors election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Wayne_State_University_Board_of_Governors_election"]] },
        { name: "Christa Murphy", party: "Republican", nomination: "Nominated at the Republican convention.", platform: [], record: ["Businesswoman; 2022 nominee for the board"], votes: "Has not held legislative office — no legislative voting record.", sources: [["2026 WSU Board of Governors election — Wikipedia", "https://en.wikipedia.org/wiki/2026_Wayne_State_University_Board_of_Governors_election"]] },
        { name: "Paul Ragan", party: "Green", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] },
        { name: "Alex Avery", party: "Libertarian", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] },
        { name: "Jami Van Alstine", party: "Libertarian", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] },
        { name: "Kathleen Oakford", party: "Natural Law", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] },
        { name: "Jeff McDonald", party: "U.S. Taxpayers", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] },
        { name: "Suzanne Roehrig", party: "Working Class", nomination: "Listed \"On the Ballot\".", nodata: true, sources: [["WSU Governors ballot status — Transparency USA", "https://www.transparencyusa.org/mi/race/wayne-state-university-board-of-governors"]] }
      ]
    }
  ],
  ballotQuestions: [
    {
      title: "Constitutional convention question",
      short: "Constitutional convention",
      text: "The constitutionally required every-16-years question: shall Michigan hold a convention to revise the state constitution? A 'yes' vote calls the convention; a 'no' vote keeps the current constitution."
    },
    {
      title: "Campaign-finance initiative (utilities and government contractors)",
      short: "Campaign finance",
      text: "An initiated law on the November ballot (official designation: Michigan Utility and Government Contractor Campaign Finance Regulations Initiative). It would prohibit regulated electric and gas utilities, contractors with over $250,000 annually in government contracts, and people and organizations with substantial connections to them from making campaign contributions to officeholders who impact them, and expand donor-disclosure rules for political communications. Signatures certified July 2026; ballot language approved August 2026."
    },
    {
      title: "Southeast Michigan Public Historical Museum Authority millage (Wayne & Oakland counties)",
      short: "Museum millage",
      text: "A 0.2-mill property tax (20 cents per $1,000 of taxable value) for ten years, 2026 through 2035. About $30 per year on a home with a $300,000 market value; Oakland County estimates about $16 million collected in the first year. The Authority's Articles of Incorporation — adopted by both county commissions in July 2026 — lock in the revenue split: 15% of each county's collections goes to that county for other public historical museums there (though either county may redirect its share to the two main museums); of the remainder, 60% to the Charles H. Wright Museum of African American History and 40% to the Detroit Historical Museum and Dossin Great Lakes Museum. No millage revenue may pay for maintenance deferred before the Articles were adopted. The Authority must meet under the Open Meetings Act, comply with FOIA, and obtain an annual audit under government auditing standards; its museum contracts must include free general admission for county residents, free tours, programming and transportation for schools and seniors, and teacher curriculum support. If voters in either county reject the millage, the Authority dissolves. Official ballot language not yet published — verify the wording on your sample ballot before voting.",
      support: "The campaign, Yes to Our Story (a ballot question committee registered with the Wayne County Clerk, funded by the two museums), says the millage delivers ten years of stable funding, free access for residents, students, and seniors, and support for dozens of smaller local history museums.",
      oppose: "No organized Vote No committee found. The recorded opposition: State Reps. Mike Harris, Donni Steele, and Tom Kuhn (all R) spoke against the 2024 enabling bill — Harris called it a tax on Oakland homeowners \u201cto subsidize museums in Detroit that they may not ever visit\u201d; Steele said people who don't visit museums shouldn't have to pay; Kuhn's transparency amendments (Open Meetings Act, FOIA, annual audits) were rejected before the bill passed 56-53. Note: the Authority's adopted Articles now bind it to the Open Meetings Act, FOIA, and annual government-standard audits. The Oakland County Board approved the Articles 11-6 on July 16, 2026 (no votes: Commissioners Hoffman, Joliat, Long, Smiley, Spisz, Weipert).",
      sources: [
        ["Articles of Incorporation — Southeast Michigan Public Historical Museum Authority", "https://oaklandcomi.api.civicclerk.com/v1/Meetings/GetAttachmentFile(fileId=36473)"],
        ["Resolution #2026-6793 and 11-6 board vote — Oakland County minutes 7/16/2026", "https://oaklandcomi.api.civicclerk.com/v1/Meetings/GetMeetingFileStream(fileId=14034,plainText=false)"],
        ["Yes to Our Story — campaign site", "https://www.yestoourstory.com"],
        ["Yes to Our Story — FAQ", "https://www.yestoourstory.com/faq"],
        ["Museum millage: what Oakland, Wayne counties vote on — FOX 2", "https://fox2detroit.com/news/museum-millage-ballot-detroit-2026-election-november"],
        ["A millage to keep Metro Detroit's stories alive — Daily Detroit", "https://www.dailydetroit.com/a-millage-to-keep-metro-detroits-stories-alive/"],
        ["Rep. Harris: museum tax would burden Oakland County residents", "https://reprogers.gophouse.org/posts/rep-harris-museum-tax-would-burden-oakland-county-residents"],
        ["Rep. Steele votes against plan to raise property taxes", "http://www.gophouse.org/posts/rep-steele-votes-against-plan-to-raise-property-taxes-in-oakland-county"],
        ["Museum tax plan passed after transparency amendments rejected", "https://www.gophouse.org/posts/detroit-museum-tax-plan-passed-after-republican-transparency-amendments-rejected"]
      ]
    },
    {
      title: "Zoological Authority millage renewal — Detroit Zoo (Wayne, Oakland & Macomb counties)",
      short: "Zoo millage",
      text: "A renewal, voted separately in each county, of the 0.1-mill property tax (10 cents per $1,000 of taxable value) that funds zoological services through each county's Zoological Authority — first approved in 2008 and renewed in 2016 under Public Act 49 of 2008. It is not a tax increase: each county's proposal renews the millage at a slightly reduced rate and restores the small remainder that was reduced due to required rollback, for a total authorized rate of 0.10 mill for ten years, 2028 through 2037 (Wayne County: 0.0982 mill renewed and 0.0018 restored; Oakland County: 0.0927 and 0.0073; Macomb County: 0.0922 and 0.0078). About $10 per year on a home with a $200,000 market value, per the renewal campaign. Estimated first-year collections, per the official ballot text published by the county clerks: about $8,831,012 in Oakland County, about $6,145,462 in Wayne County, and about $3,845,426 in Macomb County. Funds are disbursed to the county Zoological Authority and transferred to the Detroit Zoo — supporting animal care for more than 2,000 animals and 200 species, educational and senior programs, and facility maintenance — and all funds are subject to annual independent audits. The Zoological Authority also funds the Belle Isle Nature Center. MLive put the millage at 30% of the Detroit Zoo's operating budget (October 16, 2026). Official ballot question (Wayne County wording; Oakland and Macomb counties identical except the county name): \u201cDo you approve the renewal and restoration of the levy of 0.10 mill on all taxable property in Wayne County for a period of ten (10) years, from 2028 through 2037?\u201d",
      support: "The Renew Your Zoo campaign (renewyourzoo.com) says the renewal continues a stable source of funding for expert animal care, educational opportunities for children, and engaging experiences for seniors, families and visitors, at the same rate homeowners pay today. According to the Zoological Authority, the zoo welcomes more than 1.3 million guests a year and the tri-county area receives a $190 million combined annual economic impact; residents of the three counties receive a $10 discount on zoo memberships, and seniors from all three counties are admitted free on Senior Day (FOX 2).",
      oppose: "No organized Vote No committee and no recorded opposition to the 2026 renewal found as of October 17, 2026. Recorded opposition from the previous renewal cycle: the Oxford Leader editorialized against the millage on July 27, 2016, calling the zoo \u201ca luxury, pure and simple\u201d and arguing it should be funded strictly by admission fees, memberships, donations, grants and fund-raising campaigns rather than by taxpayers; it urged Oxford and Addison residents to vote no. Note: that editorial concerned the 2016 renewal, which voters approved in all three counties (Oakland 74%, Wayne 73%, Macomb 58% — WCSX).",
      sources: [
        ["Official proposal list — November 3, 2026 general election (Wayne County Clerk)", "https://www.waynecountymi.gov/files/assets/mainsite/v/1/clerk/documents/un112026prps.pdf"],
        ["Official proposal list — November 3, 2026 general election (Oakland County Elections Division)", "https://cdn.oaklandcountymi.gov/oakland-sitefinity-prod/docs/default-source/clerk/clerk-elections/elections-voting/11032026-proposal-list.pdf"],
        ["November 2026 proposals — Macomb County Clerk, Election Department", "https://macombgovdocs.org/clerk/pdfs/elect-2026-11-03-proposals.pdf"],
        ["Get the facts about the Detroit Zoo millage renewal — Detroit Zoological Society", "https://detroitzoo.org/wp-content/uploads/2026/09/DZ_MillageFlyer26_8-5x11_Final.pdf"],
        ["Renew Your Zoo — campaign site", "https://www.renewyourzoo.com"],
        ["Detroit Zoo millage renewal: what Wayne, Oakland and Macomb counties are voting on — FOX 2", "https://fox2detroit.com/news/zoo-millage-renewal-ballot-detroit-2026-election-november"],
        ["Detroit Zoo seeks millage renewal to sustain $190M economic impact and support animal care — WCSX", "https://wcsx.com/2026/10/01/detroit-zoo-seeks-millage-renewal-to-sustain-190m-economic-impact-and-support-animal-care/"],
        ["The fate of 30% of the Detroit Zoo's operating budget is in the hands of voters — MLive, Oct 16, 2026 (Facebook post)", "https://facebook.com/100064424394542/posts/pfbid0P5Mr9VU5Azskz2HCMYXskqDhK3jdLe84RTKFhjjGG7qpywP69cYsKsgiMVTx6QZyl/"],
        ["Leader Editorial: YES to Addison Fire, NO to Detroit Zoo — Oxford Leader, July 27, 2016", "https://oxfordleader.com/articles/news/leader-editorial-yes-to-addison-fire-no-to-detroit-zoo/"]
      ]
    },
    {
      note: "Ballot language above is summarized from reporting — verify the official wording on your sample ballot before voting.",
      source: ["What's on the ballot — Detroit Free Press", "https://www.freep.com/story/news/politics/elections/2026/08/06/michigan-midterm-election-key-dates-races-on-the-ballot/91182054007/"]
    }
  ],
  officials: [
    { office: "President", name: "Donald Trump", party: "Republican", note: "Term through January 2029" },
    { office: "Vice President", name: "JD Vance", party: "Republican", note: "Term through January 2029" },
    { office: "U.S. Senator", name: "Elissa Slotkin", party: "Democratic", note: "Term through January 2029" },
    { office: "U.S. Senator", name: "Gary Peters", party: "Democratic", note: "Retiring — term ends January 2027. This is the open seat on your ballot." },
    { office: "U.S. Representative, MI-13", name: "Shri Thanedar", party: "Democratic", note: "Serves through January 2027; lost the August primary." },
    { office: "Governor", name: "Gretchen Whitmer", party: "Democratic", note: "Term-limited — leaves office January 2027. Open seat on your ballot." },
    { office: "Lieutenant Governor", name: "Garlin Gilchrist II", party: "Democratic", note: "Running for Secretary of State this cycle." },
    { office: "Secretary of State", name: "Jocelyn Benson", party: "Democratic", note: "Term-limited — running for governor." },
    { office: "Attorney General", name: "Dana Nessel", party: "Democratic", note: "Term-limited — open seat on your ballot." },
    { office: "Mayor of Detroit", name: "Mary Sheffield", party: "Democratic (municipal races are nonpartisan)", note: "Took office January 2026 — first woman elected mayor of Detroit.", source: ["2025 Detroit mayoral election — Wikipedia", "https://en.wikipedia.org/wiki/2025_Detroit_mayoral_election"] },
    { office: "Wayne County Executive", name: "Warren Evans", party: "Democratic", note: "In office since 2015." },
    { office: "Your precinct's offices", name: "Michigan State Senate, Michigan State House, Wayne County Commission, Detroit City Council", party: "", note: "These depend on your exact address — check your sample ballot at the Michigan Secretary of State's voter information center." }
  ],
  quiz: [
    {
      q: "Abortion access in Michigan should be…",
      options: [
        { t: "Kept legal and accessible", for: ["Jocelyn Benson", "Abdul El-Sayed"] },
        { t: "Limited by new restrictions", for: ["John James", "Mike Rogers"] }
      ]
    },
    {
      q: "Voting rules should…",
      options: [
        { t: "Expand ballot access", for: ["Jocelyn Benson", "Abdul El-Sayed"] },
        { t: "Require photo ID / proof of citizenship", for: ["John James", "Anthony Forlini"] }
      ]
    },
    {
      q: "On health care, the priority should be…",
      options: [
        { t: "Guaranteed coverage for everyone (Medicare for All)", for: ["Abdul El-Sayed"] },
        { t: "Lowering prescription and care costs within the current system", for: ["Jocelyn Benson"] }
      ]
    },
    {
      q: "On guns, Michigan should move toward…",
      options: [
        { t: "Stronger gun-safety laws", for: ["Jocelyn Benson", "Abdul El-Sayed"] },
        { t: "Protecting gun rights", for: ["Mike Rogers"] }
      ]
    },
    {
      q: "On the economy, the priority should be…",
      options: [
        { t: "A $15 minimum wage and higher taxes on the wealthy", for: ["Abdul El-Sayed"] },
        { t: "Holding corporations accountable and cutting everyday costs", for: ["Jocelyn Benson"] },
        { t: "Pro-manufacturing, Michigan-first growth", for: ["John James"] }
      ]
    },
    {
      q: "On energy and climate, Michigan should…",
      options: [
        { t: "Pursue Green New Deal-scale climate action", for: ["Abdul El-Sayed"] },
        { t: "Oppose electric-vehicle mandates", for: ["Mike Rogers"] }
      ]
    }
  ]
};

window.GUIDE = GUIDE;
