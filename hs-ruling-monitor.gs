/**
 * HS Code 유권해석(Ruling) 주간 모니터링 시스템
 * ─────────────────────────────────────────────
 * [변경 이력]
 * v3.0
 *  - [버그] 동북아(한국/일본) 카테고리가 이메일 CATEGORY_ORDER에 없어 메일에서 누락되던 문제 수정
 *  - [버그] 지역 프롬프트에 "last 30 days"가 하드코딩되어 MONITORING_DAYS(14일)와 모순되던 문제 수정
 *          → {DAYS}/{YEAR} 플레이스홀더로 동적 치환
 *  - [버그] 그룹 지역(아르헨티나/칠레/파나마 등)의 country → category 역매핑 실패 수정 (countries 배열 도입)
 *  - [핵심] 원문 URL 정확도 개선:
 *      ① Gemini google_search grounding 메타데이터(groundingChunks/Supports)에서 실제 검색 출처 URL 추출
 *      ② 모델이 URL을 지어내지 못하도록 프롬프트 강화 (모르면 빈 값)
 *      ③ 수집된 URL 실제 접속 검증(UrlFetchApp) 후 상태 기록
 *      ④ 이메일 링크 우선순위: 원문 URL → 공식 DB 직링크(미국 CBP 등) → 공식 사이트 한정 구글검색(site:) → 일반 구글검색
 *  - [핵심] 중복 수집 방지: 동향DB 기존 데이터와 비교해 (국가+Ruling번호 / 국가+영문제목) 중복 제거
 *  - API 호출 배치 처리 + 429/5xx 재시도 (전 지역 동시 호출로 인한 rate limit 대응)
 *  - 글로벌 통상언론/WCO 검색 패스 추가 (공식 DB 미공개 국가 커버리지 보완)
 *  - 동향DB에 카테고리/URL상태/URL출처 컬럼 추가
 *  - HTML 이스케이프 처리 (모델 출력에 <, >, & 포함 시 메일 레이아웃 깨짐 방지)
 *  - listAvailableModels() 진단 함수 추가 (사용 가능한 Gemini 모델명 확인용)
 *
 * v2.0
 *  - 모니터링 주기: 최근 30일 → 최근 14일(2주)
 *  - 수신자가 "HS 요청" 메일 발송 시 자동 재발송 기능 추가
 *
 * [초기 설정] — 총 2단계
 * ① 스크립트 속성에 GEMINI_API_KEY 등록
 * ② 구글 시트가 열린 상태에서 setupAllTriggers() 1회 실행
 */

// ─── 설정 상수 ──────────────────────────────────────────────────────────────

// ※ 'gemini-3.5-flash'는 존재하지 않는 모델명일 수 있음.
//    google_search 그라운딩을 지원하는 모델 사용 필수 (예: gemini-2.5-flash / gemini-2.5-pro).
//    listAvailableModels() 실행 → 로그에서 실제 사용 가능 모델명 확인 후 수정.
var MODEL_NAME      = 'gemini-2.5-flash';
var DB_SHEET_NAME   = '동향DB';
var RCPT_SHEET_NAME = '발송인 명단';

var MONITORING_DAYS = 14;

// API 호출 배치 크기/대기 — 무료 등급은 분당 요청 제한이 낮으므로 배치로 나눠 호출
var API_BATCH_SIZE     = 7;
var API_BATCH_PAUSE_MS = 2000;
var API_MAX_RETRY      = 2;     // 429/5xx 시 개별 재시도 횟수

// URL 실접속 검증 최대 건수 (Apps Script 6분 실행 제한 고려)
var URL_VERIFY_MAX = 25;

// Gmail 폴링용 라벨 (처리 완료 메일 마킹 — 없으면 자동 생성)
var PROCESSED_LABEL = 'HS-요청-처리완료';

// ─── 모니터링 지역/사이트 구성 ───────────────────────────────────────────────
// isGroup   : true → 묶음 호출. Gemini가 country 필드에 실제 국가명을 채움
// countries : 그룹 호출 시 포함 국가 목록 (category 역매핑 및 country 보정용)
// prompt 내 {DAYS} → MONITORING_DAYS, {YEAR} → 실행 연도로 자동 치환됨
var MONITORING_REGIONS = [

  // ── 동북아 ──
  {
    category: '동북아', region: '한국',
    source  : '관세청 CLIP (관세평가분류원)',
    prompt  : 'Search for HS Code tariff classification rulings from South Korea published in the last {DAYS} days. ' +
              'Look broadly in: Korea Customs CLIP / 관세법령정보포털 (unipass.customs.go.kr/clip), 관세평가분류원 보도자료, customs news sites (한국관세신문, 관세무역신문), trade publications, and any web source reporting on Korean customs rulings. ' +
              'Keywords: "품목분류 사전심사" "관세품목분류위원회 결정" "HS코드 유권해석" "품목분류 결정례" "스마트폰" "에어컨" "Samsung" "LG전자" "tariff classification ruling Korea {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '동북아', region: '일본',
    source  : 'Japan Customs 사전교시 DB',
    prompt  : 'Search for HS Code tariff classification rulings from Japan published in the last {DAYS} days. ' +
              'Look broadly in: Japan Customs 事前教示回答事例 (customs.go.jp), Japanese customs news, trade publications, and any web source reporting on Japanese customs rulings. ' +
              'Keywords: "事前教示" "関税分類" "品目分類" "税関 分類事例" "スマートフォン" "エアコン" "Samsung" "Apple" "Japan tariff classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중국 ──
  {
    category: '중국', region: '중국',
    source  : '中国海关总署 (China General Administration of Customs)',
    prompt  : 'Search for HS Code tariff classification rulings from China published in the last {DAYS} days. ' +
              'Look broadly in: China customs (customs.gov.cn), 归类决定 announcements, Chinese trade news, WTO notifications, and any web source reporting on Chinese customs classification. ' +
              'Keywords: "商品归类" "归类决定" "税则归类" "海关总署公告 归类" "智能手机" "空调" "Samsung" "Huawei" "Apple" "China HS classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 북미 ──
  {
    category: '북미', region: '미국',
    source  : 'U.S. CBP CROSS',
    prompt  : 'Search for HS Code tariff classification rulings from the United States published in the last {DAYS} days. ' +
              'Look broadly in: CBP CROSS (rulings.cbp.gov), Customs Bulletin and Decisions, Federal Register, CustomsMobile, customs trade news, and any web source reporting on US tariff classification. ' +
              'Keywords: "CBP tariff classification ruling" "CROSS ruling NY N" "HQ H ruling" "HTS classification" "smartphone" "air conditioner" "Samsung" "Apple" "LG" "US customs ruling {YEAR}". ' +
              'For each CROSS ruling, the ruling number looks like "N123456" or "H345678" — always include it in ruling_number. ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '북미', region: '캐나다',
    source  : 'CBSA National Tariff Classification Rulings',
    prompt  : 'Search for HS Code tariff classification rulings from Canada published in the last {DAYS} days. ' +
              'Look broadly in: CBSA advance rulings (cbsa-asfc.gc.ca), CITT appeal decisions, Canadian customs news, trade publications, and any web source reporting on Canadian customs rulings. ' +
              'Keywords: "CBSA tariff classification advance ruling" "CITT appeal tariff" "Canada customs classification" "smartphone" "Samsung" "Apple" "LG" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중남미 ──
  {
    category: '중남미', region: '멕시코',
    source  : 'SAT Mexico',
    prompt  : 'Search for HS Code tariff classification rulings from Mexico published in the last {DAYS} days. ' +
              'Look broadly in: SAT Mexico (sat.gob.mx), ANAM, Diario Oficial de la Federación, Mexican trade news, customs publications, and any web source reporting on Mexican customs rulings. ' +
              'Keywords: "SAT clasificación arancelaria" "fracción arancelaria México" "TIGIE" "criterio de clasificación" "smartphone" "teléfono celular" "Samsung" "Apple" "Mexico tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '브라질',
    source  : 'Receita Federal do Brasil (RFB)',
    prompt  : 'Search for HS Code tariff classification rulings from Brazil published in the last {DAYS} days. ' +
              'Look broadly in: Receita Federal Soluções de Consulta (normas.receita.fazenda.gov.br), Brazilian trade news, NCM updates, and any web source reporting on Brazilian customs classification. ' +
              'Keywords: "Solução de Consulta classificação fiscal NCM" "Receita Federal NCM" "smartphone" "telefone celular" "Samsung" "Apple" "Brazil tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '콜롬비아',
    source  : 'DIAN Colombia',
    prompt  : 'Search for HS Code tariff classification rulings from Colombia published in the last {DAYS} days. ' +
              'Look broadly in: DIAN Colombia (dian.gov.co) clasificación arancelaria resolutions, Colombian customs news, trade publications. ' +
              'Keywords: "DIAN resolución clasificación arancelaria Colombia" "arancel Colombia aduanas" "Colombia tariff classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '페루',
    source  : 'SUNAT Peru',
    prompt  : 'Search for HS Code tariff classification rulings from Peru published in the last {DAYS} days. ' +
              'Look broadly in: SUNAT Peru (sunat.gob.pe) resoluciones de clasificación arancelaria, Peruvian customs news, trade publications. ' +
              'Keywords: "SUNAT resolución clasificación arancelaria Perú" "INTA Perú arancel" "Peru tariff classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '아르헨티나/칠레/파나마', isGroup: true,
    countries: ['아르헨티나', '칠레', '파나마'],
    source  : 'ARCA(아르헨티나) / Aduana Chile / ANA(파나마)',
    prompt  : 'Search for HS Code tariff classification rulings from Argentina, Chile, or Panama published in the last {DAYS} days. ' +
              'Look broadly in: Argentina ARCA/AFIP (afip.gob.ar), Chile Customs (aduana.cl) resoluciones de clasificación, Panama ANA (ana.gob.pa), and any web source reporting on these countries\' customs rulings. ' +
              'Keywords: "clasificación arancelaria Argentina" "Aduana Chile resolución clasificación" "ANA Panamá arancel" "smartphone" "Samsung" "Apple" "tariff classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (아르헨티나 / 칠레 / 파나마) in the country field for each ruling found.'
  },

  // ── 인도 ──
  {
    category: '인도', region: '인도',
    source  : 'India CBIC / Customs Authority for Advance Rulings',
    prompt  : 'Search for HS Code tariff classification rulings from India published in the last {DAYS} days. ' +
              'Look broadly in: CBIC (cbic.gov.in), Customs Authority for Advance Rulings (CAAR Mumbai / CAAR Delhi), CESTAT classification decisions, customs circulars, TaxGuru, Taxscan, trade news. ' +
              'Keywords: "CAAR advance ruling classification" "CESTAT classification" "CBIC circular classification" "HSN classification India" "customs tariff heading" "smartphone" "air conditioner" "Samsung" "Apple" "LG" "India ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 유럽 ──
  {
    category: '유럽', region: 'EU',
    source  : 'EU BTI (Binding Tariff Information)',
    prompt  : 'Search for HS Code tariff classification rulings from the European Union published in the last {DAYS} days. ' +
              'Look broadly in: EU BTI/EBTI database (ec.europa.eu), EU Classification Regulations published in the Official Journal (EUR-Lex), CJEU tariff classification judgments, EU customs news, and any web source reporting on EU customs classification. ' +
              'Keywords: "EU classification regulation Combined Nomenclature" "Commission Implementing Regulation classification" "BTI binding tariff information" "CJEU tariff classification" "smartphone" "air conditioner" "Samsung" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '유럽', region: '영국',
    source  : 'UK HMRC ADD (Advance Tariff Ruling)',
    prompt  : 'Search for HS Code tariff classification rulings from the United Kingdom published in the last {DAYS} days. ' +
              'Look broadly in: UK HMRC Advance Tariff Rulings, UK Trade Tariff (trade-tariff.service.gov.uk), First-tier Tribunal tariff classification decisions, UK customs news, trade publications. ' +
              'Keywords: "UK HMRC advance tariff ruling" "UK commodity code classification" "tribunal tariff classification UK" "smartphone" "Samsung" "Apple" "UK tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중동 ──
  {
    category: '중동', region: '사우디아라비아/UAE', isGroup: true,
    countries: ['사우디아라비아', 'UAE'],
    source  : 'ZATCA(사우디) / UAE FCA',
    prompt  : 'Search for HS Code tariff classification rulings from Saudi Arabia or UAE published in the last {DAYS} days. ' +
              'Look broadly in: Saudi ZATCA (zatca.gov.sa), UAE Federal Customs Authority, Dubai Customs, GCC customs news, trade publications, and any web source reporting on these countries\' customs rulings. ' +
              'Keywords: "ZATCA tariff classification Saudi" "Dubai Customs HS classification" "GCC tariff ruling" "تصنيف جمركي" "smartphone" "Samsung" "Apple" "Huawei" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (사우디아라비아 / UAE) in the country field.'
  },
  {
    category: '중동', region: '튀르키예',
    source  : 'Turkish Ministry of Trade (Ticaret Bakanlığı)',
    prompt  : 'Search for HS Code tariff classification rulings from Turkey published in the last {DAYS} days. ' +
              'Look broadly in: Turkish Ministry of Trade (ticaret.gov.tr), Gümrükler Genel Müdürlüğü, Bağlayıcı Tarife Bilgisi (BTB), Turkish customs news, trade publications. ' +
              'Keywords: "bağlayıcı tarife bilgisi" "gümrük tarife sınıflandırması" "tarife kararı" "Turkey customs classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중동', region: '이집트/요르단/이라크/모로코/파키스탄/이스라엘', isGroup: true,
    countries: ['이집트', '요르단', '이라크', '모로코', '튀니지', '알제리', '파키스탄', '이스라엘'],
    source  : '이집트 / 요르단 / 이라크 / 모로코 / 튀니지 / 알제리 / 파키스탄 / 이스라엘',
    prompt  : 'Search for HS Code tariff classification rulings from any of these countries published in the last {DAYS} days: ' +
              'Egypt, Jordan, Iraq, Morocco, Tunisia, Algeria, Pakistan, Israel. ' +
              'Look broadly in official customs authorities and any web source (news, trade publications) reporting on customs rulings from these countries. ' +
              'Keywords: "Egypt customs classification ruling" "Morocco ADII tariff" "Tunisia douane classification" "Algeria douane tariff" ' +
              '"Pakistan FBR customs classification ruling" "Pakistan Customs Appellate Tribunal classification" "Israel customs tariff ruling" "Jordan customs classification" ' +
              '"تصنيف جمركي" "classification tarifaire" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only. ' +
              'Use the actual country name (이집트 / 요르단 / 이라크 / 모로코 / 튀니지 / 알제리 / 파키스탄 / 이스라엘) in the country field.'
  },

  // ── 동남아/오세아니아 ──
  {
    category: '동남아', region: '인도네시아/말레이시아/태국', isGroup: true,
    countries: ['인도네시아', '말레이시아', '태국'],
    source  : '인도네시아 Bea Cukai / 말레이시아 Royal Customs / 태국 Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Indonesia, Malaysia, or Thailand published in the last {DAYS} days. ' +
              'Look broadly in: Indonesia Bea Cukai (beacukai.go.id) penetapan klasifikasi, Malaysia Customs (customs.gov.my) ketetapan kastam / customs ruling, Thailand Customs (customs.go.th) advance tariff ruling, ASEAN trade news. ' +
              'Keywords: "penetapan klasifikasi barang Indonesia" "Malaysia customs ruling tariff classification" "Thailand advance tariff ruling" "smartphone" "Samsung" "Apple" "ASEAN tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (인도네시아 / 말레이시아 / 태국) in the country field.'
  },
  {
    category: '동남아', region: '베트남/필리핀/싱가포르', isGroup: true,
    countries: ['베트남', '필리핀', '싱가포르'],
    source  : '베트남 General Customs / 필리핀 BOC / 싱가포르 Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Vietnam, Philippines, or Singapore published in the last {DAYS} days. ' +
              'Look broadly in: Vietnam Customs (customs.gov.vn) phân loại hàng hóa decisions, Philippines Tariff Commission / BOC tariff classification rulings, Singapore Customs (customs.gov.sg), ASEAN trade news. ' +
              'Keywords: "quyết định phân loại hàng hóa" "Philippines tariff classification ruling" "Singapore customs classification" "smartphone" "Samsung" "Apple" "ASEAN tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (베트남 / 필리핀 / 싱가포르) in the country field.'
  },
  {
    category: '동남아', region: '호주/뉴질랜드', isGroup: true,
    countries: ['호주', '뉴질랜드'],
    source  : 'Australian Border Force / New Zealand Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Australia or New Zealand published in the last {DAYS} days. ' +
              'Look broadly in: ABF Australia tariff advice / Tariff Classification Gazette (abf.gov.au), New Zealand Customs rulings (customs.govt.nz), trade news. ' +
              'Keywords: "Australia tariff advice classification" "ABF tariff classification gazette" "New Zealand customs tariff ruling" "smartphone" "Samsung" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (호주 / 뉴질랜드) in the country field.'
  },

  // ── 아프리카 ──
  {
    category: '아프리카', region: '아프리카', isGroup: true,
    countries: ['남아프리카공화국', '나이지리아', '케냐'],
    source  : 'SARS(남아공) / Nigeria Customs / KRA(케냐)',
    prompt  : 'Search for HS Code tariff classification rulings from South Africa, Nigeria, or Kenya published in the last {DAYS} days. ' +
              'Look broadly in: SARS tariff determinations (sars.gov.za), Nigeria Customs (customs.gov.ng), Kenya KRA customs rulings (kra.go.ke), African trade news. ' +
              'Keywords: "SARS tariff determination classification" "Nigeria customs HS code ruling" "Kenya KRA customs classification" "smartphone" "Samsung" "Apple" "Africa tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (남아프리카공화국 / 나이지리아 / 케냐) in the country field.'
  },

  // ── CIS ──
  {
    category: 'CIS', region: 'CIS', isGroup: true,
    countries: ['러시아', '카자흐스탄', '우즈베키스탄'],
    source  : 'ФТС(러시아) / КГД(카자흐스탄) / ГТК(우즈베키스탄)',
    prompt  : 'Search for HS Code tariff classification rulings from Russia, Kazakhstan, or Uzbekistan published in the last {DAYS} days. ' +
              'Look broadly in: Russia FCS классификационные решения (customs.gov.ru), EAEU/ЕЭК classification decisions (eec.eaeunion.org), Kazakhstan KGD (kgd.gov.kz), Uzbekistan customs (customs.uz), CIS trade news. ' +
              'Keywords: "классификационное решение ТН ВЭД" "решение ЕЭК классификация" "Kazakhstan customs tariff classification" "смартфон" "кондиционер" "Samsung" "Huawei" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (러시아 / 카자흐스탄 / 우즈베키스탄) in the country field.'
  },

  // ── 글로벌 (통상 전문지/WCO — 공식 DB 미공개 국가 보완) ──
  {
    category: '글로벌', region: '글로벌 통상언론/WCO', isGroup: true,
    countries: [],
    source  : 'WCO / 글로벌 통상 전문지 / 로펌 Trade Alert',
    prompt  : 'Search global trade press, law firm alerts and WCO sources for NEW or notable HS / tariff classification rulings, disputes or court decisions from ANY country, published in the last {DAYS} days. ' +
              'Look broadly in: WCO news (wcoomd.org), Lexology, Mondaq, Law360, Bloomberg Law, Reuters, Sandler Travis trade report, KPMG/EY/Deloitte/PwC trade & customs alerts, CustomsMobile, customs law firm newsletters. ' +
              'Keywords: "tariff classification ruling" "HS code classification dispute" "customs classification decision court" "advance ruling classification" "smartphone" "air conditioner" "TV" "Samsung" "LG" "Apple" "{YEAR}". ' +
              'Do NOT report items already covered by official customs DB monitoring (CBP CROSS routine weekly rulings) unless they are notable. ' +
              'Use the actual country name in KOREAN in the country field (예: 미국, 독일, 인도, 베트남).'
  }

];

// ─── 국가별 공식 DB 정보 ─────────────────────────────────────────────────────
// rulingUrl : ruling_number만으로 원문 직링크 생성 가능한 경우의 템플릿 ({NUM} 치환)
// searchUrl : 공식 DB 검색 페이지에 검색어를 넘길 수 있는 경우의 템플릿 ({Q} 치환)
// domain    : 위 둘이 없으면 구글 site: 검색으로 공식 사이트 내 검색 링크 생성
var OFFICIAL_DB = {
  '미국'            : { agency: 'CBP CROSS',            domain: 'rulings.cbp.gov',
                        rulingUrl: 'https://rulings.cbp.gov/ruling/{NUM}',
                        searchUrl: 'https://rulings.cbp.gov/search?term={Q}' },
  '한국'            : { agency: '관세법령정보포털(CLIP)', domain: 'unipass.customs.go.kr' },
  '일본'            : { agency: 'Japan Customs 事前教示', domain: 'customs.go.jp' },
  '중국'            : { agency: '海关总署',              domain: 'customs.gov.cn' },
  '캐나다'          : { agency: 'CBSA',                  domain: 'cbsa-asfc.gc.ca' },
  '멕시코'          : { agency: 'SAT',                   domain: 'sat.gob.mx' },
  '브라질'          : { agency: 'Receita Federal',       domain: 'normas.receita.fazenda.gov.br' },
  '콜롬비아'        : { agency: 'DIAN',                  domain: 'dian.gov.co' },
  '페루'            : { agency: 'SUNAT',                 domain: 'sunat.gob.pe' },
  '아르헨티나'      : { agency: 'ARCA',                  domain: 'afip.gob.ar' },
  '칠레'            : { agency: 'Aduana Chile',          domain: 'aduana.cl' },
  '파나마'          : { agency: 'ANA',                   domain: 'ana.gob.pa' },
  '인도'            : { agency: 'CBIC',                  domain: 'cbic.gov.in' },
  'EU'              : { agency: 'EU EBTI',               domain: 'ec.europa.eu',
                        searchUrl: 'https://ec.europa.eu/taxation_customs/dds2/ebti/ebti_consultation.jsp?Lang=en' },
  '영국'            : { agency: 'UK Trade Tariff',       domain: 'gov.uk',
                        searchUrl: 'https://www.trade-tariff.service.gov.uk/search?q={Q}' },
  '튀르키예'        : { agency: 'Ticaret Bakanlığı',     domain: 'ticaret.gov.tr' },
  '사우디아라비아'  : { agency: 'ZATCA',                 domain: 'zatca.gov.sa' },
  'UAE'             : { agency: 'UAE Customs',           domain: 'gov.ae' },
  '이집트'          : { agency: 'Egyptian Customs',      domain: 'customs.gov.eg' },
  '요르단'          : { agency: 'Jordan Customs',        domain: 'customs.gov.jo' },
  '모로코'          : { agency: 'ADII',                  domain: 'douane.gov.ma' },
  '파키스탄'        : { agency: 'FBR',                   domain: 'fbr.gov.pk' },
  '이스라엘'        : { agency: 'Israel Tax Authority',  domain: 'gov.il' },
  '인도네시아'      : { agency: 'Bea Cukai',             domain: 'beacukai.go.id' },
  '말레이시아'      : { agency: 'Royal Malaysian Customs', domain: 'customs.gov.my' },
  '태국'            : { agency: 'Thai Customs',          domain: 'customs.go.th' },
  '베트남'          : { agency: 'Vietnam Customs',       domain: 'customs.gov.vn' },
  '필리핀'          : { agency: 'Philippine Tariff Commission', domain: 'tariffcommission.gov.ph' },
  '싱가포르'        : { agency: 'Singapore Customs',     domain: 'customs.gov.sg' },
  '호주'            : { agency: 'ABF',                   domain: 'abf.gov.au' },
  '뉴질랜드'        : { agency: 'NZ Customs',            domain: 'customs.govt.nz' },
  '남아프리카공화국': { agency: 'SARS',                  domain: 'sars.gov.za' },
  '나이지리아'      : { agency: 'Nigeria Customs',       domain: 'customs.gov.ng' },
  '케냐'            : { agency: 'KRA',                   domain: 'kra.go.ke' },
  '러시아'          : { agency: 'ФТС России',            domain: 'customs.gov.ru' },
  '카자흐스탄'      : { agency: 'КГД',                   domain: 'kgd.gov.kz' },
  '우즈베키스탄'    : { agency: 'Customs Uzbekistan',    domain: 'customs.uz' }
};

// ─── 국가별 Google 검색 언어 설정 ────────────────────────────────────────────
var COUNTRY_SEARCH_LANG = {
  '한국'          : { hl: 'ko',    gl: 'KR', queryField: 'title'    },
  '일본'          : { hl: 'ja',    gl: 'JP', queryField: 'title_en' },
  '중국'          : { hl: 'zh-CN', gl: 'CN', queryField: 'title_en' },
  '미국'          : { hl: 'en',    gl: 'US', queryField: 'title_en' },
  '캐나다'        : { hl: 'en',    gl: 'CA', queryField: 'title_en' },
  '멕시코'        : { hl: 'es',    gl: 'MX', queryField: 'title_en' },
  '브라질'        : { hl: 'pt-BR', gl: 'BR', queryField: 'title_en' },
  '콜롬비아'      : { hl: 'es',    gl: 'CO', queryField: 'title_en' },
  '페루'          : { hl: 'es',    gl: 'PE', queryField: 'title_en' },
  '아르헨티나'    : { hl: 'es',    gl: 'AR', queryField: 'title_en' },
  '칠레'          : { hl: 'es',    gl: 'CL', queryField: 'title_en' },
  '파나마'        : { hl: 'es',    gl: 'PA', queryField: 'title_en' },
  '인도'          : { hl: 'en',    gl: 'IN', queryField: 'title_en' },
  'EU'            : { hl: 'en',    gl: 'BE', queryField: 'title_en' },
  '영국'          : { hl: 'en',    gl: 'GB', queryField: 'title_en' },
  '사우디아라비아': { hl: 'ar',    gl: 'SA', queryField: 'title_en' },
  'UAE'           : { hl: 'ar',    gl: 'AE', queryField: 'title_en' },
  '이스라엘'      : { hl: 'iw',    gl: 'IL', queryField: 'title_en' },
  '이라크'        : { hl: 'ar',    gl: 'IQ', queryField: 'title_en' },
  '요르단'        : { hl: 'ar',    gl: 'JO', queryField: 'title_en' },
  '이집트'        : { hl: 'ar',    gl: 'EG', queryField: 'title_en' },
  '모로코'        : { hl: 'fr',    gl: 'MA', queryField: 'title_en' },
  '튀니지'        : { hl: 'fr',    gl: 'TN', queryField: 'title_en' },
  '알제리'        : { hl: 'fr',    gl: 'DZ', queryField: 'title_en' },
  '튀르키예'      : { hl: 'tr',    gl: 'TR', queryField: 'title_en' },
  '파키스탄'      : { hl: 'en',    gl: 'PK', queryField: 'title_en' },
  '인도네시아'    : { hl: 'id',    gl: 'ID', queryField: 'title_en' },
  '말레이시아'    : { hl: 'ms',    gl: 'MY', queryField: 'title_en' },
  '태국'          : { hl: 'th',    gl: 'TH', queryField: 'title_en' },
  '베트남'        : { hl: 'vi',    gl: 'VN', queryField: 'title_en' },
  '필리핀'        : { hl: 'en',    gl: 'PH', queryField: 'title_en' },
  '싱가포르'      : { hl: 'en',    gl: 'SG', queryField: 'title_en' },
  '호주'          : { hl: 'en',    gl: 'AU', queryField: 'title_en' },
  '뉴질랜드'      : { hl: 'en',    gl: 'NZ', queryField: 'title_en' },
  '남아프리카공화국': { hl: 'en',  gl: 'ZA', queryField: 'title_en' },
  '나이지리아'    : { hl: 'en',    gl: 'NG', queryField: 'title_en' },
  '케냐'          : { hl: 'en',    gl: 'KE', queryField: 'title_en' },
  '러시아'        : { hl: 'ru',    gl: 'RU', queryField: 'title_en' },
  '카자흐스탄'    : { hl: 'ru',    gl: 'KZ', queryField: 'title_en' },
  '우즈베키스탄'  : { hl: 'ru',    gl: 'UZ', queryField: 'title_en' }
};

// ─── 원문/검색 링크 생성 ─────────────────────────────────────────────────────

/**
 * 링크 우선순위:
 *  ① item.url (grounding/모델 제공 + 접속 검증 통과) → "원문 보기"
 *  ② 공식 DB 직링크 템플릿 (예: 미국 CBP rulings.cbp.gov/ruling/{번호}) → "원문 보기 (기관명)"
 *  ③ 공식 DB 검색 / 공식 도메인 한정 구글 검색(site:) → "공식 DB 검색"
 *  ④ 일반 구글 검색 (현지 언어 hl/gl) → "구글 검색"
 * 항상 ①or② 버튼 + ③ + ④ 순으로 최대 3개 버튼을 표시한다.
 */
function _buildSourceLink(item) {
  var buttons  = [];
  var official = OFFICIAL_DB[item.country] || null;

  function btn(url, label, color) {
    return '<a href="' + url + '" target="_blank" ' +
           'style="color:' + color + ';text-decoration:none;font-size:12px;font-weight:bold;' +
           'border:1px solid ' + color + ';padding:2px 10px;border-radius:4px;margin-right:6px;display:inline-block;margin-bottom:3px;">' +
           label + '</a>';
  }

  // ① 수집된 원문 URL (검증 실패 'FAIL'은 제외, 미검증은 표시)
  var urlOk = item.url && /^https?:\/\//i.test(item.url) &&
              String(item.url_status || '').indexOf('FAIL') === -1;
  if (urlOk) {
    var srcName = item.url_source ? ' (' + _escapeHtml(item.url_source) + ')' : '';
    buttons.push(btn(_escapeHtml(item.url), '원문 보기' + srcName, '#b71c1c'));
  }
  // ② 공식 DB 직링크 (ruling_number 기반) — ①이 없거나 ①이 공식DB가 아닐 때 보조 제공
  else if (official && official.rulingUrl && item.ruling_number) {
    var directUrl = official.rulingUrl.replace('{NUM}', encodeURIComponent(String(item.ruling_number).trim()));
    buttons.push(btn(directUrl, '원문 보기 (' + official.agency + ')', '#b71c1c'));
  }

  // 검색어 조합: Ruling번호 + 제목(현지/영문) + 기관명
  var langCfg   = COUNTRY_SEARCH_LANG[item.country] || { hl: 'en', gl: 'US', queryField: 'title_en' };
  var queryText = (langCfg.queryField === 'title' && item.title)
                  ? item.title
                  : (item.title_en || item.product_name_en || item.product_name || '');
  var searchParts = [];
  if (item.ruling_number) searchParts.push(item.ruling_number);
  if (queryText)          searchParts.push(queryText);
  var baseQuery = searchParts.join(' ').trim();

  // ③ 공식 DB 검색
  if (official && baseQuery) {
    if (official.searchUrl) {
      buttons.push(btn(official.searchUrl.replace('{Q}', encodeURIComponent(baseQuery)),
                       '공식 DB 검색 (' + official.agency + ')', '#2e7d32'));
    } else if (official.domain) {
      var siteUrl = 'https://www.google.com/search?q=' +
                    encodeURIComponent(baseQuery + ' site:' + official.domain);
      buttons.push(btn(siteUrl, '공식 사이트 검색 (' + official.agency + ')', '#2e7d32'));
    }
  }

  // ④ 일반 구글 검색 (현지 언어)
  if (baseQuery || item.source) {
    var gParts = searchParts.slice();
    if (item.source) gParts.push(String(item.source).split(' ')[0]);
    var googleUrl = 'https://www.google.com/search?q=' + encodeURIComponent(gParts.join(' ')) +
                    '&hl=' + langCfg.hl + '&gl=' + langCfg.gl;
    buttons.push(btn(googleUrl, '구글 검색', '#1565c0'));
  }

  if (!buttons.length) return '<span style="color:#aaa;font-size:12px;">링크 정보 없음</span>';
  return buttons.join('');
}

// ─── Spreadsheet 헬퍼 ───────────────────────────────────────────────────────

function _getSpreadsheet() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) {
    throw new Error(
      '[오류] Spreadsheet ID를 찾을 수 없습니다.\n' +
      '구글 시트가 열린 상태에서 setupAllTriggers()를 먼저 실행하세요.'
    );
  }
  return SpreadsheetApp.openById(ssId);
}

function _saveSpreadsheetId() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('[오류] 구글 시트가 열려 있지 않습니다.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
  Logger.log('[init] Spreadsheet ID 저장: ' + active.getId());
}

// ─── 메인 실행 함수 ──────────────────────────────────────────────────────────

function runHSRulingMonitor() {
  var props  = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');

  var today        = new Date();
  var periodStart  = new Date(today.getTime() - MONITORING_DAYS * 24 * 60 * 60 * 1000);
  var dateRangeStr = _fmtDate(periodStart) + ' ~ ' + _fmtDate(today);

  Logger.log('[HSRulingMonitor] 실행 시작: ' + dateRangeStr);

  var requests = MONITORING_REGIONS.map(function(r) {
    return _buildRequest(r, apiKey, dateRangeStr, today.getFullYear());
  });

  // 배치 단위로 호출 + 429/5xx 재시도 (rate limit 대응)
  var responses = _fetchAllInBatches(requests);

  var allResults = [];
  responses.forEach(function(resp, i) {
    var region = MONITORING_REGIONS[i];
    if (!resp) { Logger.log('[' + region.region + '] 응답 없음(재시도 실패)'); return; }
    try {
      var items = _parseGeminiResponse(resp, region.region);
      items.forEach(function(item) {
        item.category = region.category;
        if (!region.isGroup) {
          item.country = region.region;
        } else if (!item.country && region.countries && region.countries.length) {
          item.country = region.countries[0];
        }
      });
      if (items.length > 0) {
        allResults.push.apply(allResults, items);
        Logger.log('[' + region.category + '/' + region.region + '] ' + items.length + '건 수집');
      } else {
        Logger.log('[' + region.category + '/' + region.region + '] 결과 없음');
      }
    } catch (e) {
      Logger.log('[' + region.region + '] 파싱 오류: ' + e.message);
    }
  });

  // 중복 제거: ① 이번 배치 내 ② 동향DB 기존 데이터 대비
  var deduped  = _dedupResults(allResults);
  var dupCount = allResults.length - deduped.length;
  if (dupCount > 0) Logger.log('[HSRulingMonitor] 중복 ' + dupCount + '건 제외');

  // 수집된 URL 실제 접속 검증
  _verifyItemUrls(deduped);

  _saveToSheet(deduped, dateRangeStr);
  _sendEmail(deduped, dateRangeStr, dupCount);

  Logger.log('[HSRulingMonitor] 완료. 신규 ' + deduped.length + '건 / 중복 제외 ' + dupCount + '건.');
}

// ─── API 호출 배치/재시도 ────────────────────────────────────────────────────

/**
 * 요청 배열을 API_BATCH_SIZE 단위로 나눠 fetchAll 호출.
 * 429/5xx 응답은 개별적으로 최대 API_MAX_RETRY회 재시도 (지수 백오프).
 * @returns {Array<HTTPResponse|null>} 요청 인덱스 순서 유지
 */
function _fetchAllInBatches(requests) {
  var responses = new Array(requests.length);

  for (var start = 0; start < requests.length; start += API_BATCH_SIZE) {
    var batch = requests.slice(start, start + API_BATCH_SIZE);
    var batchResp;
    try {
      batchResp = UrlFetchApp.fetchAll(batch);
    } catch (e) {
      Logger.log('[fetchAll] 배치 오류(idx ' + start + '~): ' + e.message);
      batchResp = batch.map(function() { return null; });
    }
    batchResp.forEach(function(r, j) { responses[start + j] = r; });
    if (start + API_BATCH_SIZE < requests.length) Utilities.sleep(API_BATCH_PAUSE_MS);
  }

  // 실패 건 개별 재시도
  for (var i = 0; i < responses.length; i++) {
    var code = responses[i] ? responses[i].getResponseCode() : 0;
    if (code === 200) continue;
    if (code !== 429 && code < 500 && responses[i]) continue; // 4xx(429 제외)는 재시도 무의미

    for (var attempt = 1; attempt <= API_MAX_RETRY; attempt++) {
      Utilities.sleep(Math.pow(2, attempt) * 5000); // 10초, 20초
      try {
        var retry = UrlFetchApp.fetch(requests[i].url, requests[i]);
        responses[i] = retry;
        if (retry.getResponseCode() === 200) {
          Logger.log('[fetchAll] 재시도 성공 (idx ' + i + ', attempt ' + attempt + ')');
          break;
        }
      } catch (e) {
        Logger.log('[fetchAll] 재시도 실패 (idx ' + i + '): ' + e.message);
      }
    }
  }
  return responses;
}

// ─── 중복 제거 ───────────────────────────────────────────────────────────────

function _itemKeys(item) {
  var keys = [];
  var country = String(item.country || '').trim();
  var num     = String(item.ruling_number || '').trim();
  var titleEn = String(item.title_en || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (num)     keys.push('N|' + country + '|' + num);
  if (titleEn) keys.push('T|' + country + '|' + titleEn.substring(0, 80));
  return keys;
}

/** 동향DB의 기존 (국가+Ruling번호 / 국가+영문제목) 키 집합 로드 — 최근 2000행만 */
function _loadExistingKeys() {
  var keySet = {};
  try {
    var ss    = _getSpreadsheet();
    var sheet = ss.getSheetByName(DB_SHEET_NAME);
    if (!sheet || sheet.getLastRow() <= 1) return keySet;
    var lastRow  = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 2000 + 1);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 14).getValues();
    data.forEach(function(row) {
      _itemKeys({ country: row[2], ruling_number: row[4], title_en: row[10] })
        .forEach(function(k) { keySet[k] = true; });
    });
  } catch (e) {
    Logger.log('[dedup] 기존 키 로드 실패: ' + e.message);
  }
  return keySet;
}

function _dedupResults(results) {
  var seen  = _loadExistingKeys();
  var fresh = [];
  results.forEach(function(item) {
    var keys = _itemKeys(item);
    var dup  = keys.some(function(k) { return seen[k]; });
    if (dup) return;
    keys.forEach(function(k) { seen[k] = true; });
    fresh.push(item);
  });
  return fresh;
}

// ─── URL 검증 ────────────────────────────────────────────────────────────────

/**
 * 수집된 url을 실제 접속해 검증하고 item.url_status에 기록.
 *  - 200~399          : OK
 *  - 401/403/405/429  : OK(차단) — URL은 존재하나 봇 차단으로 추정 → 링크 유지
 *  - 그 외(404 등)    : FAIL — 이메일에서 원문 버튼 대신 검색 버튼으로 대체
 * Apps Script 실행시간 제한을 고려해 최대 URL_VERIFY_MAX건만 검증.
 */
function _verifyItemUrls(items) {
  var targets = [];
  items.forEach(function(it) {
    if (!it.url) { it.url_status = ''; return; }
    if (!/^https?:\/\//i.test(it.url)) { it.url = ''; it.url_status = 'FAIL(형식)'; return; }
    if (targets.length < URL_VERIFY_MAX) targets.push(it);
    else it.url_status = 'SKIP';
  });
  if (!targets.length) return;

  var reqs = targets.map(function(it) {
    return { url: it.url, method: 'get', muteHttpExceptions: true,
             followRedirects: true, validateHttpsCertificates: false };
  });
  try {
    var resps = UrlFetchApp.fetchAll(reqs);
    resps.forEach(function(r, i) {
      var c = r.getResponseCode();
      if ((c >= 200 && c < 400) || c === 401 || c === 403 || c === 405 || c === 429) {
        targets[i].url_status = 'OK';
      } else {
        targets[i].url_status = 'FAIL(' + c + ')';
      }
    });
  } catch (e) {
    Logger.log('[verifyUrls] 검증 오류(링크는 유지): ' + e.message);
    targets.forEach(function(it) { if (!it.url_status) it.url_status = 'SKIP'; });
  }
}

// ─── "HS 요청" 메일 수신 감지 및 자동 재발송 ─────────────────────────────────

function checkHsRequestEmails() {
  Logger.log('[checkHsRequestEmails] 폴링 시작');

  var label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(PROCESSED_LABEL);
    Logger.log('[checkHsRequestEmails] 라벨 생성: ' + PROCESSED_LABEL);
  }

  var recipients = _getRecipients();
  if (!recipients.length) {
    Logger.log('[checkHsRequestEmails] 발송인 명단 없음 — 종료');
    return;
  }

  var fromFilter  = recipients.map(function(e) { return 'from:' + e; }).join(' OR ');
  var searchQuery = '(' + fromFilter + ') ("HS 요청") -label:' + PROCESSED_LABEL + ' newer_than:1d';

  var threads = GmailApp.search(searchQuery);
  Logger.log('[checkHsRequestEmails] 감지된 스레드 수: ' + threads.length);
  if (!threads.length) return;

  var lastData = _loadLastReportData();
  if (!lastData.results.length) {
    Logger.log('[checkHsRequestEmails] 저장된 리포트 데이터 없음 — 재발송 생략');
    threads.forEach(function(t) { t.addLabel(label); });
    return;
  }

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var lastMsg  = messages[messages.length - 1];
    var fromRaw  = lastMsg.getFrom();
    var m        = fromRaw.match(/<([^>]+)>/);
    var requester = (m ? m[1] : fromRaw).trim();

    Logger.log('[checkHsRequestEmails] "HS 요청" 감지: ' + requester);

    try {
      var html    = _buildEmailHtml(lastData.results, lastData.dateRange, 0);
      var subject = '[HS Ruling 동향] 재발송 요청 응답 | HS Classification Ruling Report (' + lastData.dateRange + ')';
      GmailApp.sendEmail(
        requester, subject,
        '이 메일은 HTML 형식을 지원하는 메일 클라이언트에서 확인하세요.',
        { htmlBody: html, name: 'HS Ruling 모니터링 시스템' }
      );
      Logger.log('[checkHsRequestEmails] 재발송 완료 → ' + requester);
    } catch (e) {
      Logger.log('[checkHsRequestEmails] 발송 실패 (' + requester + '): ' + e.message);
    }

    thread.addLabel(label);
  });
}

/**
 * 동향DB 시트에서 가장 마지막 실행분 데이터를 로드해 반환
 * (v3.0에서 추가된 카테고리/URL상태/URL출처 컬럼은 있으면 사용, 없으면 역매핑)
 */
function _loadLastReportData() {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return { results: [], dateRange: '' };

  var data        = sheet.getDataRange().getValues();
  var lastRunTime = data[data.length - 1][0];
  var recentRows  = data.slice(1).filter(function(row) { return row[0] === lastRunTime; });

  var results = recentRows.map(function(row) {
    return {
      category       : row.length > 14 ? row[14] : '',
      country        : row[2],
      source         : row[3],
      ruling_number  : row[4],
      hs_code        : row[5],
      product_name   : row[6],
      product_name_en: row[7],
      company        : row[8],
      title          : row[9],
      title_en       : row[10],
      summary        : row[11],
      issue_date     : row[12],
      url            : row[13],
      url_status     : row.length > 15 ? row[15] : '',
      url_source     : row.length > 16 ? row[16] : ''
    };
  });

  // category 없는 구버전 행 → country 기준 역매핑
  var countryToCat = {};
  MONITORING_REGIONS.forEach(function(r) {
    countryToCat[r.region] = r.category;
    (r.countries || []).forEach(function(c) { countryToCat[c] = r.category; });
  });
  results.forEach(function(r) {
    if (!r.category) r.category = countryToCat[r.country] || r.country;
  });

  return { results: results, dateRange: recentRows[0] ? recentRows[0][1] : '' };
}

// ─── Gemini 요청 생성 ────────────────────────────────────────────────────────

function _buildRequest(region, apiKey, dateRangeStr, year) {
  var regionPrompt = region.prompt
    .replace(/\{DAYS\}/g, String(MONITORING_DAYS))
    .replace(/\{YEAR\}/g, String(year));

  var userPrompt =
    'You are an HS Code tariff classification expert. ' +
    'Use web search to investigate recent tariff classification rulings from the customs authority specified below.\n\n' +

    '[ TARGET CUSTOMS AUTHORITY ]\n' +
    regionPrompt + '\n\n' +

    '[ SEARCH PERIOD ]\n' +
    dateRangeStr + ' (last ' + MONITORING_DAYS + ' days). ' +
    'Rulings ISSUED earlier but newly REPORTED/PUBLISHED within this period are also acceptable.\n\n' +

    '[ COLLECTION CRITERIA — OR condition ]\n\n' +

    '▶ A. Collect if the ruling relates to ANY of the following products:\n' +
    '   Smartphone, mobile phone, tablet, smartwatch, smart glasses, Bluetooth earphones, earbuds,\n' +
    '   air conditioner, heat pump, chiller, oven, refrigerator, vacuum cleaner,\n' +
    '   TV, television, monitor, soundbar, interactive whiteboard (electronic whiteboard),\n' +
    '   air dresser (clothing care machine), shoe dresser (shoe care machine), camera,\n' +
    '   mock-up (display model / non-functional sample),\n' +
    '   5G base station, antenna, wireless communication equipment, X-ray equipment, medical imaging device\n\n' +

    '▶ B. Collect if ANY of the following companies is mentioned as applicant or related party:\n' +
    '   Apple, Samsung, LG Electronics, Huawei, Xiaomi, Oppo, Vivo,\n' +
    '   Whirlpool, General Electric, Haier\n\n' +

    '▶ C. Collect if the ruling involves a product classified under HS Chapter 39, 40, 42, 72, 73, 83, 84, 85, 90, 91 or 94\n\n' +

    '[ OUTPUT INSTRUCTIONS ]\n' +
    '1. Report ONLY rulings you actually found in the web search results. NEVER fabricate rulings, ruling numbers, dates, HS codes or URLs.\n' +
    '2. "url" field — CRITICAL: copy the EXACT URL of the web page where you found this ruling, taken directly from your search results. ' +
       'If you are not 100% sure of the exact URL, set "url" to "" (empty string). NEVER construct, guess or recall a URL from memory.\n' +
    '3. "url_source": the name of the website/publication the url belongs to (e.g., "CBP CROSS", "Lexology", "관세청 보도자료"). Empty if url is empty.\n' +
    '4. Return AT MOST 15 rulings, most recent first.\n' +
    '5. Output STRICTLY VALID JSON between the markers: double-quoted keys and strings, no trailing commas, no comments, ' +
       'escape internal double quotes as \\". Do not wrap the JSON in markdown code fences.\n' +
    '6. Briefly describe findings in natural language first, then output the JSON block.\n' +
    '7. Even if no results: output JSON_RESULT_START\\n[]\\nJSON_RESULT_END\n\n' +

    'JSON_RESULT_START\n' +
    '[\n' +
    '  {\n' +
    '    "country": "' + region.region + '",\n' +
    '    "source": "' + region.source + '",\n' +
    '    "ruling_number": "",\n' +
    '    "hs_code": "",\n' +
    '    "product_name": "Korean product name",\n' +
    '    "product_name_en": "English product name",\n' +
    '    "company": "",\n' +
    '    "title": "Korean title or key summary",\n' +
    '    "title_en": "English title or key summary",\n' +
    '    "summary": "Classification rationale in Korean (2-3 sentences)",\n' +
    '    "issue_date": "YYYY-MM-DD",\n' +
    '    "url": "",\n' +
    '    "url_source": ""\n' +
    '  }\n' +
    ']\n' +
    'JSON_RESULT_END';

  var payload = {
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] }
    ],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 16384 }
  };

  return {
    url               : 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent?key=' + apiKey,
    method            : 'post',
    contentType       : 'application/json',
    payload           : JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

// ─── 응답 파싱 ───────────────────────────────────────────────────────────────

function _parseGeminiResponse(response, regionName) {
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    Logger.log('[' + regionName + '] HTTP ' + code + ': ' + body.substring(0, 500));
    return [];
  }
  var parsed;
  try { parsed = JSON.parse(body); } catch (e) { return []; }

  var candidate = (parsed.candidates || [])[0];
  if (!candidate) return [];

  var finishReason = candidate.finishReason || '';
  if (finishReason === 'SAFETY' || finishReason === 'RECITATION') return [];
  if (finishReason === 'MAX_TOKENS') {
    Logger.log('[' + regionName + '] 경고: MAX_TOKENS로 응답 잘림 — 일부 결과 유실 가능');
  }

  var parts = (candidate.content && candidate.content.parts) ? candidate.content.parts : [];
  var textContent = parts.map(function(p) { return p.text || ''; }).join('\n').trim();
  if (!textContent) return [];

  var items = _robustJsonParse(textContent, regionName);

  // grounding 메타데이터에서 실제 검색 출처 URL을 추출해 url이 비어있는 항목에 보충
  try {
    _attachGroundingUrls(items, candidate);
  } catch (e) {
    Logger.log('[' + regionName + '] grounding URL 매핑 오류: ' + e.message);
  }

  return items;
}

/**
 * google_search grounding 메타데이터(groundingChunks/groundingSupports)에서
 * 실제 검색 출처 URL을 꺼내, url이 비어있는 항목에 매칭해 채운다.
 * 매칭 기준: groundingSupports의 텍스트 구간(segment.text)에
 * 해당 ruling의 ruling_number / 영문제목 / 영문물품명이 등장하는지 여부.
 * ※ chunk URI는 vertexaisearch 리다이렉트 URL이지만 클릭 시 실제 원문으로 이동한다.
 */
function _attachGroundingUrls(items, candidate) {
  if (!items || !items.length) return;
  var gm = candidate.groundingMetadata || candidate.grounding_metadata || {};
  var chunks = (gm.groundingChunks || gm.grounding_chunks || []).map(function(c) {
    var web = c.web || {};
    return { uri: web.uri || '', title: web.title || '' };
  });
  if (!chunks.length) return;
  var supports = gm.groundingSupports || gm.grounding_supports || [];

  items.forEach(function(item) {
    if (item.url && /^https?:\/\//i.test(item.url)) return; // 모델이 URL 제공 → 검증 단계에서 확인

    var keys = [item.ruling_number, item.title_en, item.product_name_en]
      .map(function(k) { return String(k || '').trim(); })
      .filter(function(k) { return k.length >= 4; });
    if (!keys.length) return;

    for (var i = 0; i < supports.length; i++) {
      var seg     = supports[i].segment || {};
      var segText = String(seg.text || '');
      if (!segText) continue;
      var hit = keys.some(function(k) { return segText.indexOf(k) !== -1; });
      if (!hit) continue;
      var idxList = supports[i].groundingChunkIndices || supports[i].grounding_chunk_indices || [];
      for (var j = 0; j < idxList.length; j++) {
        var chunk = chunks[idxList[j]];
        if (chunk && chunk.uri) {
          item.url        = chunk.uri;
          item.url_source = item.url_source || chunk.title || '검색 출처';
          return;
        }
      }
    }
  });
}

function _robustJsonParse(text, regionName) {
  // 1단계: 마커 추출
  try {
    var ms = text.indexOf('JSON_RESULT_START');
    var me = text.indexOf('JSON_RESULT_END');
    if (ms !== -1 && me > ms) {
      var between = text.substring(ms + 'JSON_RESULT_START'.length, me).trim();
      between = between.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      if (between === '' || between === '[]') return [];
      var d0 = JSON.parse(between);
      if (Array.isArray(d0)) return d0;
    }
  } catch (e) {}
  // 2단계: 직접 파싱
  try { var d1 = JSON.parse(text.trim()); if (Array.isArray(d1)) return d1; } catch (e) {}
  // 3단계: 마크다운 제거
  try {
    var cleaned = text.replace(/```json[\s\S]*?```/gi, function(m) {
      return m.replace(/```json\s*/i, '').replace(/```\s*$/, '');
    }).replace(/```/g, '').trim();
    var d2 = JSON.parse(cleaned);
    if (Array.isArray(d2)) return d2;
  } catch (e) {}
  // 4단계: 배열 패턴 추출
  try {
    var allMatches = [];
    var re = /\[[\s\S]*?\]/g; var m;
    while ((m = re.exec(text)) !== null) {
      try {
        var c = JSON.parse(m[0]);
        if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') allMatches.push(c);
      } catch (e) {}
    }
    if (allMatches.length > 0) {
      allMatches.sort(function(a, b) { return b.length - a.length; });
      return allMatches[0];
    }
  } catch (e) {}
  // 5단계: 첫[~마지막] 범위
  try {
    var s = text.indexOf('['); var e = text.lastIndexOf(']');
    if (s !== -1 && e > s) { var d4 = JSON.parse(text.substring(s, e + 1)); if (Array.isArray(d4)) return d4; }
  } catch (e) {}
  // 6단계: 자연어 "결과 없음" 감지
  var noResult = ['찾지 못했', '없습니다', '확인되지 않', '발견되지 않', 'no ruling', 'not found', 'no results', 'could not find', 'no new ruling'];
  var low = text.toLowerCase();
  if (noResult.some(function(p) { return low.indexOf(p) !== -1; })) return [];

  Logger.log('[' + regionName + '] JSON 복구 실패: ' + text.substring(0, 300));
  return [];
}

// ─── 동향DB 저장 ─────────────────────────────────────────────────────────────

var DB_HEADERS = ['수집일시', '조회기간', '국가', '기관', 'Ruling번호', 'HS코드',
                  '물품명(KO)', '물품명(EN)', '기업명', '제목(KO)', '제목(EN)', '주요내용',
                  '게시일', 'URL', '카테고리', 'URL상태', 'URL출처'];

function _saveToSheet(results, dateRangeStr) {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DB_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(DB_HEADERS);
    sheet.getRange(1, 1, 1, DB_HEADERS.length)
      .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < DB_HEADERS.length) {
    // 구버전(14컬럼) 시트 → 신규 컬럼 헤더 보강
    sheet.getRange(1, sheet.getLastColumn() + 1, 1, DB_HEADERS.length - sheet.getLastColumn())
      .setValues([DB_HEADERS.slice(sheet.getLastColumn())])
      .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
  }
  if (!results.length) return;

  var now  = _fmtDateTime(new Date());
  var rows = results.map(function(r) {
    return [now, dateRangeStr, r.country || '', r.source || '', r.ruling_number || '', r.hs_code || '',
            r.product_name || '', r.product_name_en || '', r.company || '', r.title || '',
            r.title_en || '', r.summary || '', r.issue_date || '', r.url || '',
            r.category || '', r.url_status || '', r.url_source || ''];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('[saveToSheet] ' + rows.length + '건 저장 완료');
}

// ─── 수신자 조회 ─────────────────────────────────────────────────────────────

function _getRecipients() {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(RCPT_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var email  = String(data[i][0]).trim();
    var active = String(data[i][1]).trim().toUpperCase();
    if (email && active === 'Y') list.push(email);
  }
  return list;
}

// ─── 메일 발송 ───────────────────────────────────────────────────────────────

function _sendEmail(results, dateRangeStr, dupCount) {
  var recipients = _getRecipients();
  if (!recipients.length) return;
  var html    = _buildEmailHtml(results, dateRangeStr, dupCount || 0);
  var subject = '[HS Ruling 동향] 주간 유권해석 모니터링 | HS Classification Ruling Report (' + dateRangeStr + ')';
  recipients.forEach(function(email) {
    try {
      GmailApp.sendEmail(email, subject,
        '이 메일은 HTML 형식을 지원하는 메일 클라이언트에서 확인하세요.',
        { htmlBody: html, name: 'HS Ruling 모니터링 시스템' });
      Logger.log('[sendEmail] 발송: ' + email);
    } catch (e) {
      Logger.log('[sendEmail] 실패 (' + email + '): ' + e.message);
    }
  });
}

// ─── HTML 이메일 생성 ────────────────────────────────────────────────────────

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _buildEmailHtml(results, dateRangeStr, dupCount) {
  var now        = _fmtDateTime(new Date());
  var totalCount = results.length;

  // ※ MONITORING_REGIONS의 category와 반드시 일치해야 함 (불일치 시 해당 카테고리 메일 누락)
  var CATEGORY_ORDER = ['동북아', '중국', '북미', '중남미', '인도', '유럽', '중동', '동남아', '아프리카', 'CIS', '글로벌'];
  var CAT_META = {
    '동북아'  : { color: '#1565c0', bg: '#e3f2fd' },
    '중국'    : { color: '#c62828', bg: '#ffebee' },
    '북미'    : { color: '#bf360c', bg: '#fbe9e7' },
    '중남미'  : { color: '#2e7d32', bg: '#e8f5e9' },
    '인도'    : { color: '#e65100', bg: '#fff3e0' },
    '유럽'    : { color: '#1a237e', bg: '#e8eaf6' },
    '중동'    : { color: '#4e342e', bg: '#efebe9' },
    '동남아'  : { color: '#00695c', bg: '#e0f2f1' },
    '아프리카': { color: '#558b2f', bg: '#f1f8e9' },
    'CIS'     : { color: '#4527a0', bg: '#ede7f6' },
    '글로벌'  : { color: '#37474f', bg: '#eceff1' }
  };
  var COUNTRY_COLOR = {
    '한국': '#1565c0', '일본': '#283593', '중국': '#c62828', '미국': '#b71c1c', '캐나다': '#bf360c',
    '멕시코': '#2e7d32', '브라질': '#1b5e20', '인도': '#e65100', 'EU': '#1a237e', '영국': '#0d47a1'
  };
  function getCountryColor(c) { return COUNTRY_COLOR[c] || '#546e7a'; }

  var byCat = {};
  results.forEach(function(r) {
    var cat = r.category || '기타'; var country = r.country || '기타';
    if (!byCat[cat])          byCat[cat] = {};
    if (!byCat[cat][country]) byCat[cat][country] = [];
    byCat[cat][country].push(r);
  });

  // CATEGORY_ORDER에 없는 카테고리도 누락 없이 뒤에 렌더링
  var renderOrder = CATEGORY_ORDER.slice();
  Object.keys(byCat).forEach(function(cat) {
    if (renderOrder.indexOf(cat) === -1) renderOrder.push(cat);
  });

  var statsBadges = '';
  renderOrder.forEach(function(cat) {
    if (!byCat[cat]) return;
    var cnt  = Object.keys(byCat[cat]).reduce(function(s, c) { return s + byCat[cat][c].length; }, 0);
    var meta = CAT_META[cat] || { color: '#546e7a', bg: '#eceff1' };
    statsBadges +=
      '<td align="center" style="padding:6px 10px;">' +
        '<div style="font-size:17px;font-weight:bold;color:' + meta.color + ';">' + cnt + '</div>' +
        '<div style="font-size:10px;color:#666;margin-top:1px;">' + _escapeHtml(cat) + '</div>' +
      '</td>';
  });

  var cardHtml = '';
  if (totalCount === 0) {
    cardHtml =
      '<tr><td style="padding:40px 24px;text-align:center;">' +
        '<div style="background:#f8f9fa;border-radius:8px;padding:30px;border:1px dashed #ccc;">' +
          '<p style="font-size:15px;color:#555;margin:0 0 8px 0;font-weight:bold;">이번 기간 신규 Ruling 사례 없음</p>' +
          '<p style="font-size:13px;color:#888;margin:0;">검색 기간 ' + dateRangeStr + ' (최근 ' + MONITORING_DAYS + '일) 내 조건에 맞는 신규 Ruling이 확인되지 않았습니다.' +
          (dupCount > 0 ? '<br>(기존 수집분과 중복된 ' + dupCount + '건은 제외되었습니다.)' : '') + '</p>' +
        '</div>' +
      '</td></tr>';
  } else {
    renderOrder.forEach(function(cat) {
      if (!byCat[cat]) return;
      var catMeta  = CAT_META[cat] || { color: '#546e7a', bg: '#eceff1' };
      var catCount = Object.keys(byCat[cat]).reduce(function(s, c) { return s + byCat[cat][c].length; }, 0);

      cardHtml +=
        '<tr><td style="padding:20px 24px 4px 24px;">' +
          '<div style="background:' + catMeta.bg + ';border-left:5px solid ' + catMeta.color + ';' +
               'border-radius:0 6px 6px 0;padding:10px 16px;">' +
            '<span style="font-size:15px;font-weight:bold;color:' + catMeta.color + ';">' + _escapeHtml(cat) + '</span>' +
            '<span style="margin-left:10px;background:' + catMeta.color + ';color:#fff;' +
                 'font-size:11px;font-weight:bold;padding:2px 9px;border-radius:10px;">' +
              catCount + '건</span>' +
          '</div>' +
        '</td></tr>';

      Object.keys(byCat[cat]).forEach(function(country) {
        var items        = byCat[cat][country];
        var countryColor = getCountryColor(country);
        var source       = items[0].source || '';

        cardHtml +=
          '<tr><td style="padding:8px 24px 4px 36px;">' +
            '<span style="font-size:13px;font-weight:bold;color:' + countryColor + ';' +
                 'border-bottom:2px solid ' + countryColor + ';padding-bottom:2px;">' + _escapeHtml(country) + '</span>' +
            '<span style="font-size:11px;color:#999;margin-left:8px;">' + _escapeHtml(source) + '</span>' +
            '<span style="font-size:11px;color:#fff;background:' + countryColor + ';' +
                 'border-radius:8px;padding:1px 7px;margin-left:6px;font-weight:bold;">' +
              items.length + '건</span>' +
          '</td></tr>';

        items.forEach(function(item) {
          var hsTag = item.hs_code
            ? '<span style="background:#e3f2fd;color:#0d47a1;font-size:11px;font-weight:bold;' +
                   'padding:2px 7px;border-radius:4px;margin-left:6px;font-family:monospace;">' + _escapeHtml(item.hs_code) + '</span>'
            : '';
          var coTag = item.company
            ? '<span style="background:#fce8e6;color:#b71c1c;font-size:11px;padding:2px 7px;' +
                   'border-radius:4px;margin-left:4px;">' + _escapeHtml(item.company) + '</span>'
            : '';
          var rulingTag = item.ruling_number
            ? '<span style="color:#aaa;font-size:11px;margin-left:6px;">[' + _escapeHtml(item.ruling_number) + ']</span>'
            : '';
          var titleKo = _escapeHtml(item.title || item.product_name || '제목 없음');
          var titleEn = _escapeHtml(item.title_en || item.product_name_en || '');

          var urlLink = _buildSourceLink(item);

          cardHtml +=
            '<tr><td style="padding:3px 24px 8px 36px;">' +
              '<table width="100%" cellpadding="0" cellspacing="0" ' +
                     'style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;background:#fff;">' +
                '<tr><td style="background:#f9f9f9;padding:11px 16px;border-bottom:1px solid #eeeeee;">' +
                  '<div style="font-size:13px;font-weight:bold;color:#202124;line-height:1.5;">' +
                    titleKo + hsTag + coTag + rulingTag +
                  '</div>' +
                  (titleEn ? '<div style="font-size:11px;color:#666;margin-top:3px;">' + titleEn + '</div>' : '') +
                '</td></tr>' +
                '<tr><td style="padding:11px 16px;">' +
                  '<table width="100%" cellpadding="0" cellspacing="0">' +
                    '<tr>' +
                      '<td style="width:70px;font-size:11px;color:#888;font-weight:bold;padding-bottom:6px;vertical-align:top;">물품명</td>' +
                      '<td style="font-size:12px;color:#333;padding-bottom:6px;">' +
                        _escapeHtml(item.product_name || '-') +
                        (item.product_name_en ? '<span style="color:#999;margin-left:6px;font-size:11px;">(' + _escapeHtml(item.product_name_en) + ')</span>' : '') +
                      '</td>' +
                    '</tr>' +
                    '<tr>' +
                      '<td style="width:70px;font-size:11px;color:#888;font-weight:bold;padding-bottom:6px;vertical-align:top;">주요내용</td>' +
                      '<td style="font-size:12px;color:#333;line-height:1.7;padding-bottom:6px;">' + _escapeHtml(item.summary || '-') + '</td>' +
                    '</tr>' +
                    '<tr>' +
                      '<td style="width:70px;font-size:11px;color:#888;font-weight:bold;padding-bottom:6px;">게시일</td>' +
                      '<td style="font-size:12px;color:#333;padding-bottom:6px;">' + _escapeHtml(item.issue_date || '-') + '</td>' +
                    '</tr>' +
                  '</table>' +
                '</td></tr>' +
                '<tr><td style="padding:7px 16px 10px 16px;background:#fafafa;border-top:1px solid #eeeeee;">' +
                  urlLink +
                '</td></tr>' +
              '</table>' +
            '</td></tr>';
        });
      });
    });
  }

  return '<!DOCTYPE html>' +
  '<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
  '<body style="margin:0;padding:0;background:#f1f3f4;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',Arial,sans-serif;">' +
  '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f4;padding:24px 0;"><tr><td align="center">' +
  '<table width="680" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.10);">' +

  '<tr><td style="background:linear-gradient(135deg,#0d1b5e 0%,#1565c0 100%);padding:28px 28px 22px 28px;">' +
    '<div style="color:#90caf9;font-size:11px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:6px;">Trade Compliance Intelligence</div>' +
    '<div style="color:#ffffff;font-size:21px;font-weight:bold;line-height:1.3;margin-bottom:3px;">HS Code 유권해석 주간 동향 보고서</div>' +
    '<div style="color:#bbdefb;font-size:14px;margin-bottom:10px;">Weekly HS Classification Ruling Monitoring Report</div>' +
    '<table cellpadding="0" cellspacing="0"><tr>' +
      '<td style="color:#bbdefb;font-size:13px;">조회 기간&nbsp;' + dateRangeStr + '</td>' +
      '<td style="color:#bbdefb;font-size:13px;padding-left:20px;">발행일&nbsp;' + now + '</td>' +
    '</tr></table>' +
  '</td></tr>' +

  '<tr><td style="background:#e8f0fe;padding:12px 28px;border-bottom:2px solid #c5cae9;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="font-size:13px;color:#1a237e;">' +
        '<b>이번 기간 수집 현황</b>&nbsp;&nbsp;|&nbsp;&nbsp;' +
        '신규 <b style="color:#1565c0;font-size:15px;">' + totalCount + '</b>건' +
        (dupCount > 0 ? ' <span style="color:#888;font-size:11px;">(중복 ' + dupCount + '건 제외)</span>' : '') +
        ' &nbsp;|&nbsp;&nbsp;' +
        '<b style="color:#1565c0;">' + MONITORING_REGIONS.length + '</b>개 검색 패스 (최근 ' + MONITORING_DAYS + '일)' +
      '</td>' +
    '</tr></table>' +
  '</td></tr>' +

  (totalCount > 0
    ? '<tr><td style="padding:14px 28px 8px 28px;">' +
        '<div style="font-size:10px;font-weight:bold;color:#999;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">카테고리별 수집 현황</div>' +
        '<table cellpadding="0" cellspacing="0"><tr>' + statsBadges + '</tr></table>' +
      '</td></tr>'
    : '') +

  // 재발송 안내 배너
  '<tr><td style="padding:10px 28px 4px 28px;">' +
    '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:9px 14px;font-size:12px;color:#795548;">' +
      ' <b>재발송 요청</b>: 이 메일에 "<b>HS 요청</b>"이라고 답장하시면 최신 리포트를 즉시 재발송해 드립니다.' +
    '</div>' +
  '</td></tr>' +

  '<tr><td style="padding:14px 28px 8px 28px;border-top:1px solid #eeeeee;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td width="48%" style="vertical-align:top;padding-right:8px;">' +
        '<div style="background:#f5f5f5;border-radius:6px;padding:11px 14px;">' +
          '<div style="font-size:10px;font-weight:bold;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">모니터링 품목</div>' +
          '<div style="font-size:12px;color:#333;line-height:1.9;">' +
            '스마트폰 / 태블릿 / 스마트워치 / 블루투스 이어폰<br>' +
            '에어컨 / 오븐 / 냉장고 / 청소기 / TV / 모니터 / 사운드바<br>' +
            '스마트글래스 / 히트펌프 / 칠러(Chiller) / 전자칠판 / 에어드레서<br>' +
            '슈드레서 / 카메라 / 목업(mock-up, non-functional sample)<br>' +
            '5G 기지국 / 안테나 / X-ray 의료기기 / HS 39, 40, 42, 72, 73, 83, 84, 85, 90, 91, 94류 전체' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td width="52%" style="vertical-align:top;padding-left:8px;">' +
        '<div style="background:#f5f5f5;border-radius:6px;padding:11px 14px;">' +
          '<div style="font-size:10px;font-weight:bold;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">모니터링 기업</div>' +
          '<div style="font-size:12px;color:#333;line-height:1.9;">' +
            'Apple / Samsung Electronics / LG Electronics<br>' +
            'Huawei / Xiaomi / Oppo / Vivo<br>' +
            'Whirlpool / General Electric / Haier' +
          '</div>' +
        '</div>' +
      '</td>' +
    '</tr></table>' +
  '</td></tr>' +

  cardHtml +

  '<tr><td style="background:#0d1b5e;padding:16px 28px;text-align:center;">' +
    '<div style="color:#90caf9;font-size:11px;line-height:1.8;">' +
      'Gemini AI 기반 자동 모니터링 시스템 &nbsp;|&nbsp; 매주 월요일 오전 9시 KST 정기 발행 (최근 ' + MONITORING_DAYS + '일)<br>' +
      '원문 보기 링크는 AI 검색 출처 기반으로 자동 수집·검증되며, 부정확할 수 있으니 중요 사안은 반드시 공식 DB에서 재확인하세요.' +
    '</div>' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}

// ─── 트리거 설정 ─────────────────────────────────────────────────────────────

/**
 * 구글 시트가 열린 상태에서 이 함수를 1회 실행하세요.
 *  - Spreadsheet ID 자동 저장
 *  - 매주 월요일 09:00 KST 정기 실행 트리거
 *  - 15분마다 "HS 요청" 메일 폴링 트리거
 */
function setupAllTriggers() {
  _saveSpreadsheetId();

  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runHSRulingMonitor' || fn === 'checkHsRequestEmails') {
      ScriptApp.deleteTrigger(t);
      Logger.log('[setupAllTriggers] 기존 트리거 삭제: ' + fn);
    }
  });

  ScriptApp.newTrigger('runHSRulingMonitor')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(0)
    .inTimezone('Asia/Seoul')
    .create();
  Logger.log('[setupAllTriggers] 정기 실행 트리거 등록: 매주 월요일 09:00 KST');

  ScriptApp.newTrigger('checkHsRequestEmails')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('[setupAllTriggers] 이메일 폴링 트리거 등록: 15분마다');
}

// 기존 호환성 유지
function setupWeeklyTrigger() { setupAllTriggers(); }

// ─── 수동 재발송 ─────────────────────────────────────────────────────────────

function resendLastReport() {
  var lastData = _loadLastReportData();
  if (!lastData.results.length) { Logger.log('[resendLastReport] 저장 데이터 없음'); return; }
  _sendEmail(lastData.results, lastData.dateRange, 0);
  Logger.log('[resendLastReport] ' + lastData.results.length + '건 재발송 완료');
}

// ─── 진단 유틸리티 ───────────────────────────────────────────────────────────

/**
 * 사용 가능한 Gemini 모델명 확인용 — 실행 후 로그(보기 > 실행 기록)에서 확인.
 * MODEL_NAME이 유효하지 않으면 모든 호출이 404로 실패하므로, 최초 설정 시 1회 실행 권장.
 */
function listAvailableModels() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');
  var resp = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey,
    { muteHttpExceptions: true }
  );
  var body = JSON.parse(resp.getContentText());
  (body.models || []).forEach(function(m) {
    if ((m.supportedGenerationMethods || []).indexOf('generateContent') !== -1) {
      Logger.log(m.name + '  —  ' + (m.displayName || ''));
    }
  });
}

/**
 * 단일 지역 테스트 실행 — 프롬프트/파싱/URL 추출 동작 확인용.
 * regionIndex: MONITORING_REGIONS 배열 인덱스 (기본 3 = 미국)
 */
function testSingleRegion(regionIndex) {
  var idx    = (regionIndex == null) ? 3 : regionIndex;
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');

  var today        = new Date();
  var periodStart  = new Date(today.getTime() - MONITORING_DAYS * 24 * 60 * 60 * 1000);
  var dateRangeStr = _fmtDate(periodStart) + ' ~ ' + _fmtDate(today);

  var region = MONITORING_REGIONS[idx];
  var req    = _buildRequest(region, apiKey, dateRangeStr, today.getFullYear());
  var resp   = UrlFetchApp.fetch(req.url, req);
  var items  = _parseGeminiResponse(resp, region.region);
  _verifyItemUrls(items);

  Logger.log('[test] ' + region.region + ' → ' + items.length + '건');
  items.forEach(function(it) {
    Logger.log('  - [' + (it.ruling_number || '번호없음') + '] ' + (it.title_en || it.title) +
               ' | url=' + (it.url || '없음') + ' (' + (it.url_status || '미검증') + ')');
  });
}

// ─── 유틸리티 ────────────────────────────────────────────────────────────────

function _fmtDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
function _fmtDateTime(date) {
  var h  = String(date.getHours()).padStart(2, '0');
  var mi = String(date.getMinutes()).padStart(2, '0');
  return _fmtDate(date) + ' ' + h + ':' + mi;
}
