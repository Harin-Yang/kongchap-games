/*
	콩떡찹쌀 게임방 자동 테스트
	사용법: node tests/run.js [rules|ui|online]   (생략하면 전부)
	결과: tests/report/report.md + 스크린샷
	기준서: TESTING.md
*/
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const FILE_URL = "file://" + path.join(ROOT, "index.html");
const OUT = path.join(__dirname, "report");
const MQTT_JS = fs.readFileSync(path.join(ROOT, "node_modules/mqtt/dist/mqtt.min.js"), "utf8");
const PHONE = { width: 390, height: 844 };
const ALL_GAMES = ["hive", "dojo", "tower", "wall", "omok", "four", "reversi", "dots"];
const MOVE_CAP = { omok: 120, four: 42, reversi: 64, dots: 60, wall: 80, dojo: 80, tower: 80, hive: 70 };

const only = process.argv[2] || "all";
const results = [];
let currentSection = "";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function check(name, ok, detail) {
	results.push({ section: currentSection, name: name, ok: !!ok, detail: detail || "" });
	console.log((ok ? "  PASS " : "  FAIL ") + name + (detail && !ok ? "  → " + detail : ""));
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

async function waitFor(fn, timeout, label) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		try {
			if (await fn()) {
				return true;
			}
		} catch (e) {
			/* 다시 시도 */
		}
		await sleep(80);
	}
	if (label) {
		console.log("    (시간 초과: " + label + ")");
	}
	return false;
}

/* 외부 CDN 대신 로컬 mqtt.js를 넣고, 공개 중계 서버 접속은 막는다 */
async function newPage(browser, errors, tag) {
	const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: false });
	const page = await ctx.newPage();
	await page.route(/unpkg\.com\/mqtt/, r => r.fulfill({ status: 200, contentType: "application/javascript", body: MQTT_JS }));
	await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
	await page.route(/broker\.|mosquitto/, r => r.abort());
	page.on("pageerror", e => errors.push("[" + tag + "] " + e.message));
	page.on("console", m => {
		if (m.type() === "error" && !/ERR_FAILED|net::|Failed to load resource/.test(m.text())) {
			errors.push("[" + tag + " console] " + m.text());
		}
	});
	return { ctx, page };
}

/* 화면 공통 점검: 깨진 글자, 가로 넘침 */
async function screenSanity(page, label) {
	const r = await page.evaluate(() => {
		const text = document.body.innerText;
		return {
			bad: /\bnull\b|\bundefined\b|NaN|\[object/.test(text),
			overflow: document.documentElement.scrollWidth - window.innerWidth
		};
	});
	check(label + ": 화면에 null·undefined·NaN 글자 없음", !r.bad);
	check(label + ": 가로 스크롤 없음", r.overflow <= 1, "넘침 " + r.overflow + "px");
}

/* SVG 좌표(viewBox 단위)를 화면 좌표로 바꿔 실제 클릭 */
async function clickSvg(page, vx, vy) {
	const p = await page.evaluate(([vx, vy]) => {
		const svg = document.getElementById("board");
		const vb = svg.viewBox.baseVal;
		const rc = svg.getBoundingClientRect();
		const s = rc.width / vb.width;
		return [rc.left + (vx - vb.x) * s, rc.top + (vy - vb.y) * (rc.height / vb.height)];
	}, [vx, vy]);
	await page.mouse.click(p[0], p[1]);
	await sleep(90);
}

async function closeOverlays(page) {
	await page.evaluate(() => document.querySelectorAll(".overlay").forEach(o => o.remove()));
}

/* 무작위 합법 수 하나 두기 (앱의 commit을 그대로 사용) */
async function randomMove(page) {
	return page.evaluate(() => {
		const st = S.game;
		const ms = GAMES[st.game].moves(st.s, st.turn);
		if (!ms.length) {
			return { none: true };
		}
		const m = ms[Math.floor(Math.random() * ms.length)];
		const seq = st.seq;
		commit(m);
		return { m: m, moved: S.game.seq === seq + 1 };
	});
}

/* =========================================================
	1. 규칙 단위 테스트
========================================================= */
async function testRules(browser) {
	currentSection = "규칙";
	console.log("\n[1] 규칙 단위 테스트");
	const errors = [];
	const { ctx, page } = await newPage(browser, errors, "rules");
	await page.goto(FILE_URL);
	const cases = await page.evaluate(() => {
		const out = [];
		const play = (g, moves) => {
			const G = GAMES[g];
			let s = G.init();
			let p = 0;
			let r = null;
			for (const m of moves) {
				r = G.apply(s, m, p);
				if (!r) {
					return { rejected: m, s: s, p: p };
				}
				s = r.s;
				p = r.turn;
			}
			return { r: r, s: s, p: p };
		};
		const t = (name, ok) => out.push([name, !!ok]);

		let x = play("omok", [0, 15, 1, 16, 2, 17, 3, 18, 4]);
		t("오목: 가로 다섯이면 승리", x.r.over && x.r.over.winner === 0);
		x = play("omok", [0, 15, 1, 16, 2, 17, 3]);
		t("오목: 넷이면 아직 진행", !x.r.over);
		t("오목: 같은 칸 두 번 불가", play("omok", [5, 5]).rejected === 5);

		x = play("four", [0, 1, 0, 1, 0, 1, 0]);
		t("사목: 세로 넷이면 승리", x.r.over && x.r.over.winner === 0);
		t("사목: 꽉 찬 줄 불가", play("four", [2, 2, 2, 2, 2, 2, 2]).rejected === 2);

		x = play("reversi", [19]);
		t("리버시: 끼우면 뒤집힘", x.s.b[27] === 0 && x.s.b[19] === 0);
		t("리버시: 못 뒤집는 칸 불가", play("reversi", [0]).rejected === 0);

		x = play("dots", ["h:0", "v:0", "h:5"]);
		t("땅따먹기: 네모 못 만들면 차례 넘김", x.p === 1);
		x = play("dots", ["h:0", "v:0", "h:5", "v:1"]);
		t("땅따먹기: 네모 완성하면 한 번 더", x.p === 1 && x.s.box[0] === 1);

		const W = GAMES.wall;
		let s = W.init();
		t("벽 미로: 시작 이동 3칸", W.moves(s, 0).filter(m => m[0] === "m").length === 3);
		s = { pos: [40, 31], walls: [], left: [10, 10], last: null };
		t("벽 미로: 마주 보면 뛰어넘기", W.moves(s, 0).includes("m:22"));
		s = { pos: [40, 31], walls: ["h:2:4"], left: [10, 10], last: null };
		const diag = W.moves(s, 0).filter(m => m === "m:30" || m === "m:32");
		t("벽 미로: 뒤가 막히면 대각선", diag.length === 2);
		s = { pos: [76, 0], walls: ["v:0:0"], left: [9, 10], last: null };
		t("벽 미로: 길을 완전히 막는 벽 불가", W.apply(s, "w:h:1:0", 0) === null && W.apply(s, "w:h:1:1", 0) !== null);
		t("벽 미로: 겹치는 벽 불가", W.apply({ pos: [76, 4], walls: ["h:3:3"], left: [9, 10], last: null }, "w:h:3:4", 0) === null);
		t("벽 미로: 십자 교차 벽 불가", W.apply({ pos: [76, 4], walls: ["h:3:3"], left: [9, 10], last: null }, "w:v:3:3", 0) === null);
		x = W.apply({ pos: [13, 4], walls: [], left: [10, 10], last: null }, "m:4", 0);
		t("벽 미로: 상대 말 칸으로는 이동 불가", x === null);
		x = W.apply({ pos: [12, 70], walls: [], left: [10, 10], last: null }, "m:3", 0);
		t("벽 미로: 끝줄 도착 승리", x && x.over && x.over.winner === 0);

		const D = GAMES.dojo;
		const b = Array(25).fill(null);
		b[7] = { p: 0, m: true };
		b[22] = { p: 1, m: false };
		b[0] = { p: 1, m: true };
		x = D.apply({ b: b, hands: [["게", "호랑이"], ["용", "말"]], side: "소", last: null }, "게:7:2", 0);
		t("도장 깨기: 대장이 상대 진지 도착하면 승리", x && x.over && x.over.winner === 0);
		t("도장 깨기: 쓴 카드는 옆으로, 옆 카드는 내 손으로", x && x.s.side === "게" && x.s.hands[0].includes("소"));
		const b2 = Array(25).fill(null);
		b2[12] = { p: 0, m: false };
		b2[7] = { p: 1, m: true };
		b2[22] = { p: 0, m: true };
		x = D.apply({ b: b2, hands: [["말", "게"], ["용", "소"]], side: "학", last: null }, "말:12:7", 0);
		t("도장 깨기: 상대 대장 잡으면 승리", x && x.over && x.over.winner === 0);
		x = D.apply({ b: b2, hands: [["말", "게"], ["용", "소"]], side: "학", last: null }, "용:12:7", 0);
		t("도장 깨기: 내 손에 없는 카드 불가", x === null);
		const b3 = Array(25).fill(null);
		b3[2] = { p: 1, m: true };
		b3[22] = { p: 0, m: true };
		x = D.apply({ b: b3, hands: [["호랑이", "게"], ["말", "소"]], side: "학", last: null }, "말:2:7", 1);
		t("도장 깨기: 위쪽 플레이어는 방향이 뒤집힘", x && x.s.b[7] && x.s.b[7].p === 1);

		const T = GAMES.tower;
		const ts = { h: Array(25).fill(0), w: [[0, 24], [4, 20]], setup: false, last: null };
		ts.h[1] = 2;
		t("구름 탑: 두 층 이상 한 번에 못 오름", T.apply(ts, "m:0:1:2", 0) === null);
		ts.h[1] = 1;
		x = T.apply(ts, "m:0:1:2", 0);
		t("구름 탑: 한 층 오르고 옆에 쌓기", x && x.s.h[2] === 1 && x.s.w[0][0] === 1);
		const ts2 = { h: Array(25).fill(0), w: [[0, 24], [4, 20]], setup: false, last: null };
		ts2.h[0] = 2;
		ts2.h[1] = 3;
		x = T.apply(ts2, "m:0:1:-1", 0);
		t("구름 탑: 3층에 올라서면 승리", x && x.over && x.over.winner === 0);
		const ts3 = { h: Array(25).fill(0), w: [[0, 24], [4, 20]], setup: false, last: null };
		ts3.h[1] = 4;
		t("구름 탑: 지붕 칸은 못 감", T.apply(ts3, "m:0:1:2", 0) === null);
		let ss = T.init();
		[["s:0", 0], ["s:1", 1], ["s:2", 0], ["s:3", 1]].forEach(([m, p]) => {
			const r = T.apply(ss, m, p);
			ss = r.s;
		});
		t("구름 탑: 일꾼 4명 내려놓으면 본 게임 시작", ss.setup === false);

		const H = GAMES.hive;
		const hs = (moves) => play("hive", moves);
		x = hs(["p:A:0:0", "p:A:1:0", "p:G:-1:0", "p:G:2:0", "p:S:-2:0", "p:S:3:0"]);
		t("벌집: 4번째 놓기엔 여왕벌 강제", H.apply(x.s, "p:A:-3:0", 0) === null && H.apply(x.s, "p:Q:-3:0", 0) !== null);
		x = hs(["p:Q:0:0", "p:Q:1:0", "p:A:-1:0"]);
		t("벌집: 상대 타일에 닿게 놓기 불가", H.apply(x.s, "p:A:0:1", 1) === null);
		x = hs(["p:G:0:0", "p:Q:1:0", "p:Q:-1:0", "p:A:2:0"]);
		t("벌집: 벌집을 끊는 이동 불가", !H.moves(x.s, 0).some(m => m.startsWith("m:0:0:")));
		x = hs(["p:Q:0:0", "p:Q:1:0", "p:G:-1:0", "p:A:2:0"]);
		t("벌집: 메뚜기는 일직선으로 뛰어넘음", H.moves(x.s, 0).includes("m:-1:0:3:0"));
		x = hs(["p:Q:0:0", "p:Q:1:0", "p:B:-1:0", "p:A:2:0"]);
		t("벌집: 딱정벌레는 위로 올라탐", H.moves(x.s, 0).includes("m:-1:0:0:0"));
		t("벌집: 여왕벌 전에는 움직이기 불가", !H.moves(hs(["p:A:0:0", "p:Q:1:0"]).s, 0).some(m => m[0] === "m"));
		const ring = { b: { "0,0": [{ p: 1, k: "Q" }] }, hand: [{ Q: 0, A: 0, G: 0, S: 0, B: 0 }, { Q: 0, A: 3, G: 3, S: 2, B: 2 }], placed: [10, 1], last: null };
		[[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]].forEach(([q, r], i) => {
			ring.b[q + "," + r] = [{ p: 0, k: i === 0 ? "Q" : "A" }];
		});
		ring.b["1,1"] = [{ p: 0, k: "A" }];
		x = H.apply(ring, "m:1:1:0:1", 0);
		t("벌집: 여왕벌 6면 포위하면 승리", x && x.over && x.over.winner === 0);
		return out;
	});
	cases.forEach(([n, ok]) => check(n, ok));

	const playouts = await page.evaluate((caps) => {
		const out = {};
		for (const g of Object.keys(caps)) {
			const G = GAMES[g];
			let rejected = 0;
			let stuck = 0;
			let finished = 0;
			for (let t = 0; t < 30; t++) {
				let s = G.init();
				let p = 0;
				for (let n = 0; n < caps[g] * 4; n++) {
					const ms = G.moves(s, p);
					if (!ms.length) {
						stuck++;
						break;
					}
					const r = G.apply(s, ms[Math.floor(Math.random() * ms.length)], p);
					if (!r) {
						rejected++;
						break;
					}
					s = r.s;
					p = r.turn;
					if (r.over) {
						finished++;
						break;
					}
				}
			}
			out[g] = { rejected: rejected, stuck: stuck, finished: finished };
		}
		return out;
	}, MOVE_CAP);
	for (const g of ALL_GAMES) {
		const r = playouts[g];
		check("무작위 30판(" + g + "): 합법 수가 거부되거나 막히는 일 없음", r.rejected === 0 && r.stuck === 0, JSON.stringify(r));
	}
	check("규칙 테스트 중 스크립트 오류 없음", errors.length === 0, errors.join(" | "));
	await ctx.close();
}

/* =========================================================
	2. 폰 화면 테스트 (한 폰 모드)
========================================================= */
const TAP_PLANS = {
	omok: async page => {
		const x = 16 + 7 * (288 / 14);
		await clickSvg(page, x, x);
		await clickSvg(page, x, x);
	},
	four: async page => {
		await clickSvg(page, 14 + 46 * 3 + 23, 150);
	},
	reversi: async page => {
		const i = await page.evaluate(() => rvMoves(S.game.s.b, S.game.turn)[0]);
		await clickSvg(page, 8 + (i % 8) * 38 + 19, 8 + Math.floor(i / 8) * 38 + 19);
	},
	dots: async page => {
		const G = 272 / 5;
		await clickSvg(page, 24 + G / 2, 24);
		await clickSvg(page, 24 + G / 2, 24);
	},
	wall: async page => {
		const i = await page.evaluate(() => qPawnMoves(S.game.s, S.game.turn)[0]);
		await clickSvg(page, 5 + (i % 9) * 36 + 15, 5 + Math.floor(i / 9) * 36 + 15);
	},
	dojo: async page => {
		const m = await page.evaluate(() => {
			const st = S.game;
			return oMoves(st.s, st.turn, st.s.hands[st.turn][0])[0];
		});
		await clickSvg(page, 10 + (m.from % 5) * 60 + 30, 10 + Math.floor(m.from / 5) * 60 + 30);
		await clickSvg(page, 10 + (m.to % 5) * 60 + 30, 10 + Math.floor(m.to / 5) * 60 + 30);
	},
	tower: async page => {
		await clickSvg(page, 40, 40);
	},
	hive: async page => {
		const t = await page.evaluate(() => S.game.turn);
		await page.click("#bug-" + t + "-Q");
		await sleep(80);
		await clickSvg(page, 0, 0);
	}
};

async function testUI(browser) {
	currentSection = "화면";
	console.log("\n[2] 폰 화면 테스트 (한 폰 모드)");
	const errors = [];
	const { ctx, page } = await newPage(browser, errors, "ui");
	await page.goto(FILE_URL);
	await page.waitForSelector("#nameInput");
	await page.screenshot({ path: path.join(OUT, "ui-00-home.png") });
	await screenSanity(page, "첫 화면");
	await page.fill("#nameInput", "테스터");
	await page.click("#btnNew");
	await page.waitForSelector("#g-hive");
	await page.screenshot({ path: path.join(OUT, "ui-01-room.png"), fullPage: true });
	await screenSanity(page, "방 화면");
	check("방 화면: 게임 8종 카드 표시", (await page.locator(".gcard").count()) === 8);

	for (const g of ALL_GAMES) {
		await closeOverlays(page);
		await page.click("#g-" + g);
		await page.click("#btnLocalPlay");
		await page.waitForSelector("#board");
		await sleep(150);
		const seq0 = await page.evaluate(() => S.game.seq);
		await TAP_PLANS[g](page);
		const seq1 = await page.evaluate(() => S.game.seq);
		check(g + ": 실제 터치로 한 수 두기", seq1 === seq0 + 1, "seq " + seq0 + "→" + seq1);
		await screenSanity(page, g + " 시작");
		await page.screenshot({ path: path.join(OUT, "ui-" + g + "-1-start.png"), fullPage: true });
		let n = 0;
		let over = false;
		while (n < MOVE_CAP[g]) {
			const r = await randomMove(page);
			if (r.none || !r.moved) {
				break;
			}
			n++;
			over = await page.evaluate(() => !!S.game.over);
			if (over) {
				break;
			}
			if (n === Math.floor(MOVE_CAP[g] / 3)) {
				await page.screenshot({ path: path.join(OUT, "ui-" + g + "-2-mid.png"), fullPage: true });
			}
		}
		await sleep(700);
		if (over) {
			const sheet = await page.locator(".sheet .big").count();
			check(g + ": 끝나면 결과 팝업", sheet > 0);
			await page.screenshot({ path: path.join(OUT, "ui-" + g + "-3-over.png"), fullPage: true });
			await closeOverlays(page);
			const undoBefore = await page.evaluate(() => S.history.length);
			check(g + ": 무르기 기록 쌓임", undoBefore > 0);
		} else {
			check(g + ": " + n + "수 동안 오류 없이 진행 (상한 도달)", n > 0);
		}
		await screenSanity(page, g + " 진행 후");
		await closeOverlays(page);
		await page.click("#btnToRoom");
		await page.waitForSelector("#g-hive");
	}
	await page.click("#btnStats");
	await sleep(200);
	await page.screenshot({ path: path.join(OUT, "ui-09-stats.png"), fullPage: true });
	await screenSanity(page, "전적 화면");
	check("화면 테스트 중 스크립트 오류 없음", errors.length === 0, errors.join(" | "));
	await ctx.close();
}

/* =========================================================
	3. 두 기기 실시간 대전 테스트 (로컬 중계 서버)
========================================================= */
function startBroker() {
	const aedes = require("aedes")();
	const ws = require("websocket-stream");
	const server = http.createServer();
	ws.createServer({ server: server }, aedes.handle);
	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				url: "ws://127.0.0.1:" + server.address().port,
				close: () => new Promise(r => {
					aedes.close(() => server.close(() => r()));
				})
			});
		});
	});
}

async function testOnline(browser) {
	currentSection = "온라인";
	console.log("\n[3] 두 기기 실시간 대전 테스트");
	const broker = await startBroker();
	const errors = [];
	const A = await newPage(browser, errors, "A");
	const B = await newPage(browser, errors, "B");
	const pa = A.page;
	const pb = B.page;
	const q = "?broker=" + encodeURIComponent(broker.url);

	await pa.goto(FILE_URL + q);
	await pa.fill("#nameInput", "하린");
	await pa.click("#btnNew");
	check("A: 중계 서버 연결", await waitFor(() => pa.evaluate(() => S.connected), 8000, "A 연결"));
	const room = await pa.evaluate(() => S.room);
	const link = await pa.evaluate(() => shareLink());
	check("초대 링크에 방 코드 포함", link.includes("#r=" + room));

	await pb.goto(FILE_URL + q + "#r=" + room);
	await pb.waitForSelector("#btnEnter");
	await pb.fill("#nameInput", "시아");
	await pb.click("#btnEnter");
	check("B: 링크로 같은 방 입장", await waitFor(() => pb.evaluate(r => S.connected && S.room === r, room), 8000, "B 연결"));
	check("A 화면에 B 접속 표시", await waitFor(() => pa.evaluate(() => online(partnerId()) && nameOf(partnerId()) === "시아"), 6000, "A가 B 인식"));
	check("B 화면에 A 접속 표시", await waitFor(() => pb.evaluate(() => online(partnerId()) && nameOf(partnerId()) === "하린"), 6000, "B가 A 인식"));
	await sleep(2000);
	await pa.screenshot({ path: path.join(OUT, "online-00-roomA.png"), fullPage: true });

	let finishedGames = 0;
	for (const g of ALL_GAMES) {
		await closeOverlays(pa);
		await closeOverlays(pb);
		if ((await pa.evaluate(() => S.view)) !== "room") {
			await pa.evaluate(() => go("room"));
		}
		await pa.click("#g-" + g);
		await pa.click("#btnOnline");
		const opened = await waitFor(() => pb.evaluate(gg => S.view === "game" && S.game && S.game.game === gg, g), 6000, "B 자동 입장 " + g);
		check(g + ": 상대 폰에 판이 자동으로 열림", opened);
		if (!opened) {
			await pb.evaluate(() => {
				if (S.remoteGame) {
					openOnline(S.remoteGame);
				}
			});
		}
		const same = await waitFor(async () => {
			const a = await pa.evaluate(() => S.game && S.game.gid);
			const b = await pb.evaluate(() => S.game && S.game.gid);
			return a && a === b;
		}, 5000);
		check(g + ": 두 폰이 같은 판", same);
		const seatsA = await pa.evaluate(() => S.game.seats.indexOf(ME));
		if (g === "wall" || g === "dojo") {
			const flipB = await pb.evaluate(() => S.game.seats.indexOf(ME) === 1);
			await (flipB ? pb : pa).screenshot({ path: path.join(OUT, "online-" + g + "-flipped.png"), fullPage: true });
		}

		let n = 0;
		let syncFail = 0;
		let wrongTurnBlocked = true;
		let over = false;
		while (n < MOVE_CAP[g]) {
			const actor = (await pa.evaluate(() => canAct())) ? pa : ((await pb.evaluate(() => canAct())) ? pb : null);
			if (!actor) {
				break;
			}
			const other = actor === pa ? pb : pa;
			if (n === 1) {
				wrongTurnBlocked = await other.evaluate(() => {
					const st = S.game;
					const seq = st.seq;
					const ms = GAMES[st.game].moves(st.s, st.turn);
					commit(ms[0]);
					return S.game.seq === seq;
				});
			}
			const r = await randomMove(actor);
			if (r.none || !r.moved) {
				break;
			}
			n++;
			const seq = await actor.evaluate(() => S.game.seq);
			const ok = await waitFor(() => other.evaluate(sq => S.game.seq === sq, seq), 4000);
			if (!ok) {
				syncFail++;
				break;
			}
			over = await actor.evaluate(() => !!S.game.over);
			if (over) {
				break;
			}
		}
		check(g + ": " + n + "수 모두 상대 폰에 반영", syncFail === 0 && n > 0);
		check(g + ": 상대 차례엔 둘 수 없음", wrongTurnBlocked);
		const boardsEqual = await (async () => {
			const a = await pa.evaluate(() => JSON.stringify(S.game.s));
			const b = await pb.evaluate(() => JSON.stringify(S.game.s));
			return a === b;
		})();
		check(g + ": 두 폰의 판 상태 일치", boardsEqual);
		if (over) {
			finishedGames++;
			await sleep(800);
			check(g + ": 두 폰 모두 결과 팝업", (await pa.locator(".sheet .big").count()) > 0 && (await pb.locator(".sheet .big").count()) > 0);
			await pb.screenshot({ path: path.join(OUT, "online-" + g + "-over-B.png") });
			const statsOk = await waitFor(async () => {
				const a = await pa.evaluate(() => S.stats.n);
				const b = await pb.evaluate(() => S.stats.n);
				return a === b && a === finishedGames;
			}, 5000);
			check(g + ": 전적이 두 폰에 똑같이 쌓임", statsOk);
		} else {
			await pa.screenshot({ path: path.join(OUT, "online-" + g + "-A.png"), fullPage: true });
		}
		if (seatsA < 0) {
			check(g + ": A가 자리에 앉음", false);
		}
	}

	/* 말풍선·콕 찌르기 */
	await closeOverlays(pa);
	await closeOverlays(pb);
	await pa.click("#emo0");
	check("말풍선이 상대 폰에 표시", await waitFor(() => pb.evaluate(() => !!document.querySelector(".bubble")), 3000));
	await pa.click("#emo7");
	check("콕 찌르기로 상대 화면 흔들림", await waitFor(() => pb.evaluate(() => document.getElementById("app").classList.contains("shake")), 3000));

	/* 한 판 더 (순서 바꿈) */
	const before = await pa.evaluate(() => ({ gid: S.game.gid, seats: S.game.seats.slice() }));
	await pb.evaluate(() => rematch());
	const swapped = await waitFor(() => pa.evaluate(b => S.game.gid !== b.gid && S.game.seats[0] === b.seats[1], before), 5000);
	check("한 판 더: 새 판이 상대 폰에도 열리고 선후 바뀜", swapped);

	/* 새로고침해도 이어하기 */
	await randomMove((await pa.evaluate(() => canAct())) ? pa : pb);
	await sleep(400);
	const gidNow = await pa.evaluate(() => S.game.gid);
	await pb.reload();
	const rejoined = await waitFor(() => pb.evaluate(g => S.connected && S.remoteGame && S.remoteGame.gid === g, gidNow), 8000);
	check("B 새로고침 후 자동 재입장·진행 중 판 복구", rejoined);
	check("재입장 후 '이어서 하기' 표시", await waitFor(() => pb.evaluate(() => !!document.getElementById("btnResume")), 3000));

	/* 전적 화면 */
	await pb.evaluate(() => go("stats"));
	await sleep(300);
	await pb.screenshot({ path: path.join(OUT, "online-99-stats-B.png"), fullPage: true });
	await screenSanity(pb, "B 전적 화면");
	const statsShown = await pb.evaluate(() => S.stats.log.length);
	check("전적 화면에 기록 표시 (" + statsShown + "판)", statsShown === finishedGames);

	check("온라인 테스트 중 스크립트 오류 없음", errors.length === 0, errors.join(" | "));
	await A.ctx.close();
	await B.ctx.close();
	await broker.close();
}

/* =========================================================
	보고서
========================================================= */
function writeReport(ms) {
	const pass = results.filter(r => r.ok).length;
	const fail = results.length - pass;
	const lines = [];
	lines.push("# 콩떡찹쌀 게임방 테스트 보고서");
	lines.push("");
	lines.push("- 실행: " + new Date().toISOString());
	lines.push("- 범위: " + only);
	lines.push("- 결과: **" + (fail ? "실패 " + fail + "건" : "모두 통과") + "** (통과 " + pass + " / 전체 " + results.length + ", " + (ms / 1000).toFixed(1) + "초)");
	lines.push("");
	let sec = null;
	results.forEach(r => {
		if (r.section !== sec) {
			sec = r.section;
			lines.push("## " + sec);
			lines.push("");
			lines.push("| 결과 | 항목 | 비고 |");
			lines.push("|---|---|---|");
		}
		lines.push("| " + (r.ok ? "통과" : "**실패**") + " | " + r.name + " | " + (r.ok ? "" : String(r.detail).replace(/\|/g, "/").slice(0, 200)) + " |");
	});
	lines.push("");
	lines.push("스크린샷: tests/report/*.png");
	fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
	console.log("\n결과: 통과 " + pass + " / 실패 " + fail + "  →  tests/report/report.md");
	return fail;
}

(async () => {
	const t0 = Date.now();
	const browser = await chromium.launch();
	try {
		if (only === "all" || only === "rules") {
			await testRules(browser);
		}
		if (only === "all" || only === "ui") {
			await testUI(browser);
		}
		if (only === "all" || only === "online") {
			await testOnline(browser);
		}
	} catch (e) {
		check("테스트 실행 자체가 멈춤", false, e.stack || String(e));
	}
	await browser.close();
	const fail = writeReport(Date.now() - t0);
	process.exit(fail ? 1 : 0);
})();
