export default {
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);

		// POST: Answer registration
		if (pathname === '/answer/register' && request.method === 'POST') {
			return registerAnswer(request, env);
		}

		// POST: Finish the current room challenge
		if (pathname.startsWith('/finish') && request.method === 'POST') {
			const roomCode = pathname.split('/').pop();
			return finishChallenge(roomCode, request, env);
		}

		// GET: Retrieve file list for the game
		if (pathname === '/filelist') {
			return getFileList(env);
		}

		// GET: Download file
		if (pathname.startsWith('/getfile')) {
			const filename = pathname.split('/').pop();
			return getFile(filename, env);
		}

		// GET: Get a question for a specified level and challenger
		const groupIdMatch = pathname.match(/(\w+)\/getQuestion\/(\d+)$/);
		if (groupIdMatch) {
			const groupId = groupIdMatch[1];
			const level = groupIdMatch[2];
			console.log(groupId, level);
			return getQuestion(level, groupId, env);
		}

		if (request.method === 'POST' && request.url.endsWith('/adminui/regChallenge')) {
			return await registerChallenge(request, env);
		}

		return new Response("Not found", { status: 404 });
	}
};

// Answer registration function
async function registerAnswer(request, env) {
	const { GroupId, QuestionId, Result, ChallengerAnswer } = await request.json();

	if (!GroupId || !QuestionId || !Result) {
		return new Response(JSON.stringify({ success: false, message: 'Invalid data' }), { status: 400 });
	}

	if (QuestionId !== "lv5_q1") {
		const insertAnsweredQuestion = `
            INSERT INTO AnsweredQuestions (GroupId, QuestionId, Result, ChallengerAnswer)
            VALUES (?, ?, ?, ?)
        `;
		try {
			await env.DB.prepare(insertAnsweredQuestion)
				.bind(GroupId, QuestionId, Result, ChallengerAnswer)
				.run();
		} catch (err) {
			console.error('Error updating AnsweredQuestion:', err);
			return new Response(JSON.stringify({ success: false, message: 'Database error' }), { status: 500 });
		}
	}

	const updateCountSql = Result === "Correct"
		? `UPDATE Questions SET CollectCount = CollectCount + 1 WHERE ID = ?`
		: `UPDATE Questions SET WrongCount = WrongCount + 1 WHERE ID = ?`;

	try {
		await env.DB.prepare(updateCountSql)
			.bind(QuestionId)
			.run();
		return new Response(JSON.stringify({ success: true, message: `${Result === "Correct" ? "CollectCount" : "WrongCount"} successfully updated` }), { status: 200 });
	} catch (err) {
		console.error('Error updating counts:', err);
		return new Response(JSON.stringify({ success: false, message: 'Database error' }), { status: 500 });
	}
}

// Finish challenge function
async function finishChallenge(roomCode, request, env) {
	const { result } = await request.json();

	if (!roomCode) {
		return new Response(JSON.stringify({ success: false, message: 'Room code is required' }), { status: 400 });
	}
	if (!result || (result !== 'Cleared' && result !== 'Failed')) {
		return new Response(JSON.stringify({ success: false, message: 'Invalid result value. Must be "Cleared" or "Failed".' }), { status: 400 });
	}
	try {
		const { ChallengeId, GroupId, Difficulty, GroupName } = room; // Ensure room is defined appropriately

		// Update challenge status
		const updateChallengeQuery = `UPDATE Challenges SET State = ? WHERE ChallengeId = ?`;
		await env.DB.prepare(updateChallengeQuery).bind(result, ChallengeId).run();

		if (result === "Cleared") {
			const SnackCount = [3, 4, 5][Difficulty - 1] || 0;

			const updateGroupQuery = `
                UPDATE Groups SET WasCleared = CASE WHEN WasCleared = '0' THEN '1' ELSE WasCleared END,
                SnackState = CASE WHEN SnackState = '0' THEN ? ELSE SnackState END WHERE GroupId = ?
            `;
			await env.DB.prepare(updateGroupQuery).bind(SnackCount, GroupId).run();

			const challengeQuery = `SELECT StartTime FROM Challenges WHERE ChallengeId = ?`;
			const { results: challenge } = await env.DB.prepare(challengeQuery).bind(ChallengeId).run();
			if (!challenge) throw new Error("Challenge not found");

			const diffSeconds = Math.floor((new Date() - new Date(challenge.StartTime)) / 1000);
			const insertClearTimeQuery = `
                INSERT INTO ClearTimes (ElapsedTime, ChallengeId, Difficulty, GroupName) VALUES (?, ?, ?, ?)
            `;
			await env.DB.prepare(insertClearTimeQuery).bind(diffSeconds, ChallengeId, Difficulty, GroupName).run();
		}
		return new Response(JSON.stringify({ success: true, message: 'Room and challenge processed successfully' }), { status: 200 });
	} catch (error) {
		console.error('Error in transaction:', error);
		return new Response(JSON.stringify({ success: false, message: 'Database error', error: error.message }), { status: 500 });
	}
}

// Get question for specified level
async function getQuestion(level, groupId, env) {
	return await getRandomQuestion(level, groupId, env);
}

async function getRandomQuestion(level, groupId, env, attemptCounter = 0) {
	const maxAttempts = 20; // Limit to avoid infinite recursion

	if (attemptCounter >= maxAttempts) {
		return new Response(JSON.stringify({ error: "No available questions after multiple attempts." }), { status: 404 });
	}

	try {
		const questionQuery = `
            SELECT * FROM Questions
            WHERE Difficulty = ?
            ORDER BY RANDOM()
            LIMIT 1
        `;
		const { results: questionResult } = await env.DB.prepare(questionQuery).bind(level).run();

		if (questionResult) {
			const ansStateQuery = `
                SELECT * FROM AnsweredQuestions
                WHERE GroupId = ? AND QuestionId = ?
            `;
			const { results: answeredRows } = await env.DB.prepare(ansStateQuery).bind(groupId, questionResult.ID).all();

			if (answeredRows.length > 0) {
				console.log(`Question ${questionResult.ID} already answered. Retrying... Attempt: ${attemptCounter + 1}`);
				return await getRandomQuestion(level, groupId, env, attemptCounter + 1);
			} else {
				return new Response(JSON.stringify(questionResult), { status: 200 });
			}
		} else {
			return new Response(JSON.stringify({ error: "No matching question found" }), { status: 404 });
		}
	} catch (err) {
		console.error('Error executing query:', err.message);
		return new Response(JSON.stringify({ error: "Database error", details: err.message }), { status: 500 });
	}
}

async function registerChallenge(request, env) {
	const { GroupName, playerCount, difficulty, dupCheck } = await request.json();

	if (GroupName && playerCount != null && difficulty != null) {
		const db = env.DB; // Assuming D1 is available in the environment
		const groupId = await findOrCreateGroup(db, GroupName, playerCount, dupCheck);
		const requiredQuestions = determineRequiredQuestions(difficulty);

		if (requiredQuestions === null) {
			return new Response(JSON.stringify({ success: false, message: 'Invalid difficulty level' }), { status: 400 });
		}

		if (groupId === null) {
			return new Response(JSON.stringify({ success: false, message: 'Group name already exists. Set dupCheck to true to proceed.' }), { status: 403 });
		}

		const questionCount = await countAvailableQuestions(db, groupId, difficulty);
		console.log(questionCount, requiredQuestions);
		if (questionCount >= requiredQuestions) {
			await addChallenge(db, groupId, difficulty, "Web");
			return new Response(JSON.stringify({ success: true, message: 'Challenge registered successfully' }), { status: 200 });
		} else {
			return new Response(JSON.stringify({ success: false, message: 'Not enough available questions' }), { status: 400 });
		}
		try {

		} catch (error) {
			console.error('Error in registerChallenge:', error);
			return new Response(JSON.stringify({ success: false, message: 'Error registering challenge', error: error.message }), { status: 500 });
		}
	} else {
		return new Response(JSON.stringify({ success: false, message: 'Missing required fields' }), { status: 400 });
	}
}

async function findOrCreateGroup(db, groupName, playerCount, dupCheck) {
	const checkGroupSql = `SELECT GroupId FROM Groups WHERE Name = ?`;
	const { results: existingGroup } = await db.prepare(checkGroupSql).bind(groupName).run();

	if (existingGroup.length != 0) {
		if (!dupCheck) {
			return null;
		}
		// Update group challenges count
		console.log(existingGroup[0]);
		await db.prepare(`UPDATE Groups SET ChallengesCount = ChallengesCount + 1 WHERE GroupId = ?`).bind(existingGroup[0].GroupId).run();
		return existingGroup[0].GroupId;
	} else {
		const newGroupId = crypto.randomUUID();
		await db.prepare(
			`INSERT INTO Groups(Name, GroupId, ChallengesCount, PlayerCount, WasCleared, SnackState)
            VALUES(?, ?, ?, ?, ?, ?)`
		).bind(groupName, newGroupId, 1, playerCount, 0, 0).run();
		return newGroupId;
	}
}
// Function to count available questions
async function countAvailableQuestions(db, groupId, difficulty) {
	const query =
		`SELECT COUNT(*) AS count
        FROM Questions Q
        LEFT JOIN AnsweredQuestions AQ ON Q.ID = AQ.QuestionId AND AQ.GroupId = ?
		WHERE Q.Difficulty = ? AND(AQ.Result IS NULL OR AQ.Result NOT IN('Correct', 'Wrong'))`
		;
	const { results: row } = await db.prepare(query).bind(groupId, difficulty).run();
	console.log(row[0]);
	return row[0].count;
}

// Function to add challenge to the database
async function addChallenge(db, groupId, difficulty, roomID) {
	const insertChallenge = `
        INSERT INTO Challenges (GroupId, Difficulty, RoomId, State, StartTime)
        VALUES (?, ?, ?, ?, ?)
    `;
	const challengeStartTime = new Date().toISOString();
	await db.prepare(insertChallenge).bind(groupId, difficulty, roomID, 'Pending', challengeStartTime).run();
}

// Function to determine required questions based on difficulty
function determineRequiredQuestions(difficulty) {
	switch (difficulty) {
		case 1: return 3; // Adjust as needed
		case 2: return 5; // Adjust as needed
		case 3: return 7; // Adjust as needed
		default: return null; // Invalid difficulty
	}
}
