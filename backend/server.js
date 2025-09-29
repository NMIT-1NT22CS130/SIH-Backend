const express = require('express');
const supabase = require('./db');
const multer = require('multer');
const mammoth = require('mammoth');
const path = require("path");
const fs = require("fs");
const cors=require('cors')
const axios = require("axios");
const cheerio=require('cheerio')
const app = express();

const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json());



// Enhanced HTTP client with better connection management
const httpClient = axios.create({
  timeout: 30000,
  maxRedirects: 5,
  httpAgent: new require('http').Agent({ 
    keepAlive: true,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 30000
  })
});

// Rate limiter for translation API
class RateLimiter {
  constructor(maxRequests, timeWindow) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = [];
  }

  async wait() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < this.timeWindow);
    
    if (this.requests.length >= this.maxRequests) {
      const oldest = this.requests[0];
      const waitTime = this.timeWindow - (now - oldest);
      await new Promise(resolve => setTimeout(resolve, waitTime + 100));
    }
    
    this.requests.push(now);
  }
}

const translationLimiter = new RateLimiter(5, 1000); // 5 requests per second

// Smart batching with priority
async function translateHtmlStructureOptimized(htmlEnglish) {
  const $ = cheerio.load(htmlEnglish, { decodeEntities: false });
  
  // Collect and prioritize text nodes
  const textNodes = [];
  
  $('*').each((i, element) => {
    const $el = $(element);
    if (['script', 'style', 'meta', 'link'].includes(element.tagName)) return;

    const children = $el.contents();
    children.each((j, child) => {
      if (child.type === 'text') {
        const originalText = child.data;
        const trimmedText = originalText.trim();
        
        if (trimmedText.length > 1 && !isOnlyNumbers(trimmedText)) {
          // Priority: headings > strong/b > li > p > others
          let priority = 0;
          switch(element.tagName.toLowerCase()) {
            case 'h1': priority = 5; break;
            case 'h2': priority = 4; break;
            case 'h3': priority = 3; break;
            case 'strong': case 'b': priority = 2; break;
            case 'li': priority = 1; break;
            default: priority = 0;
          }
          
          textNodes.push({
            node: child,
            originalText,
            trimmedText,
            priority,
            tagName: element.tagName
          });
        }
      }
    });
  });

  console.log(`Found ${textNodes.length} text nodes for translation`);

  if (textNodes.length === 0) return htmlEnglish;

  // Sort by priority (highest first)
  textNodes.sort((a, b) => b.priority - a.priority);

  // Process in optimized batches
  await processTranslationBatches(textNodes);
  
  return $.html();
}

function isOnlyNumbers(str) {
  return /^\d+$/.test(str.replace(/[.,]/g, ''));
}

async function processTranslationBatches(textNodes) {
  const BATCH_SIZE = 8; // Smaller batches for stability
  const DELAY_BETWEEN_BATCHES = 500; // Increased delay
  
  for (let i = 0; i < textNodes.length; i += BATCH_SIZE) {
    const batch = textNodes.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(textNodes.length/BATCH_SIZE)}`);
    
    try {
      await processBatch(batch);
      
      // Delay between batches to prevent overwhelming the API
      if (i + BATCH_SIZE < textNodes.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    } catch (error) {
      console.error(`Batch ${Math.floor(i/BATCH_SIZE) + 1} failed:`, error.message);
      // Continue with next batch instead of failing completely
    }
  }
}

async function processBatch(batch) {
  const promises = batch.map((item, index) => 
    translateWithRetry(item.trimmedText, item.tagName, index)
      .then(translated => {
        if (translated && translated.trim().length > 0) {
          item.node.data = item.originalText.replace(item.trimmedText, translated);
        }
      })
      .catch(error => {
        console.warn(`Failed to translate: "${item.trimmedText.substring(0, 50)}..."`, error.message);
        // Keep original text on failure
      })
  );

  await Promise.allSettled(promises);
}

async function translateWithRetry(text, tagName, index, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await translationLimiter.wait();
      
      // Stagger requests within batch
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * 50));
      }

      const contextHint = getContextHint(tagName);
      const payload = {
        text: text,
        to: "pa",
        context: contextHint,
        preserve_formatting: true
      };

      const response = await httpClient.post("https://translation-api-1k7k.onrender.com/translate", payload);
      
      if (response.data && response.data.translatedText) {
        return response.data.translatedText;
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.warn(`Attempt ${attempt} failed for: "${text.substring(0, 30)}..."`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Exponential backoff
      const backoffTime = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }
}

function getContextHint(tagName) {
  switch(tagName.toLowerCase()) {
    case 'h1': return 'This is a main heading title. Translate accurately.';
    case 'h2': return 'This is a section heading. Translate accurately.';
    case 'h3': case 'h4': case 'h5': case 'h6': 
      return 'This is a subheading. Translate accurately.';
    case 'li': return 'This is a list item.';
    case 'strong': case 'b': return 'This is emphasized important text.';
    case 'table': return 'This is table content.';
    default: return 'This is regular paragraph text.';
  }
}

// Progress tracking for large documents
let progressInterval;
function startProgressTracking(totalNodes) {
  let processed = 0;
  console.log(`Starting translation of ${totalNodes} text nodes...`);
  
  progressInterval = setInterval(() => {
    processed++;
    if (processed % 50 === 0) {
      console.log(`Progress: ${processed}/${totalNodes} (${Math.round((processed/totalNodes)*100)}%)`);
    }
  }, 100);
}

function stopProgressTracking() {
  if (progressInterval) {
    clearInterval(progressInterval);
  }
}

app.post('/upload', upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file uploaded" });

    const { title, subject, week, className } = req.body;
    const filePath = req.file.path;

    const ext = path.extname(req.file.originalname || "").toLowerCase();
    if (ext !== ".docx") {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "please upload a .docx file" });
    }

    const stats = await fs.promises.stat(filePath);
    if (!stats.size) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "uploaded file is empty" });
    }

    const buffer = await fs.promises.readFile(filePath);
    const result = await mammoth.convertToHtml({ buffer });
    const htmlEnglish = result.value;

    console.log("Generated HTML length:", (htmlEnglish || "").length);
    console.time("TranslationTime");

    const htmlPunjabi = await translateHtmlStructureOptimized(htmlEnglish);

    console.timeEnd("TranslationTime");

    const { data, error } = await supabase
      .from("lessons")
      .insert([{
        title,
        content: htmlEnglish,
        content_pa: htmlPunjabi,
        week,
        subject,
        class: className,
      }])
      .select();

    if (error) {
      console.error("Database error:", error);
      return res.status(400).json({ error: error.message });
    }

    fs.unlink(filePath, () => {});

    res.json({
      success: true,
      data: data[0],
      message: "Document processed successfully"
    });

  } catch (err) {
    console.error("Upload error:", err);
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ 
      error: "Processing failed", 
      details: err.message 
    });
  }
});



app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dashboard.html'));
});

app.get("/lessons", async (req, res) => {
  const { data, error } = await supabase.from("lessons").select("*").order("id", { ascending: false }).limit(1);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Fetch single lesson
app.get("/lessons/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from("lessons").select("*").eq("id", id).single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Save quiz
app.post("/quizzes", async (req, res) => {
  const { title, subject, week, className, data: quizData } = req.body;

  console.log("Incoming quiz payload:", { title, subject, week, className });

  // Step 1: Find the lesson
  const { data: lesson, error: lessonError } = await supabase
    .from("lessons")
    .select("id")
    .eq("title", title)
    .eq("subject", subject)
    .eq("week", week)
    .eq("class", className)  
    .maybeSingle();

  if (lessonError || !lesson) {
    console.error("Lesson lookup failed:", lessonError, "Lesson:", lesson);
    return res.status(404).json({ error: "Lesson not found" });
  }

  console.log("Found lesson:", lesson);

  // Step 2: Save quiz
  const { data, error } = await supabase
    .from("quizzes")
    .insert([{
      lesson_id: lesson.id,
      class: className,  
      subject,
      data: quizData,
      Week:week,
      title:title
    }])
    .select();

  if (error) {
    console.error("Quiz insert error:", error);
    return res.status(400).json({ error: error.message });
  }

  console.log("Quiz saved:", data);
  res.json(data[0]);
});



app.get("/quizzes/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("quizzes")
    .select("data")
    .eq("id", id)
    .single();

  if (error) return res.status(404).json({ error: "Quiz not found" });
  res.json(data);
});

app.post("/quizzes/submit", async (req, res) => {
  const { quiz, student_id, answers } = req.body; // 'answers' is now an object: { "questionId1": "userAnswer1", ... }

  const { data: quizData, error: quizError } = await supabase
    .from("quizzes")
    .select("data")
    .eq("id", quiz)
    .single();

  if (quizError) {
    return res.status(404).json({ error: "Quiz not found" });
  }

  const quizContent = quizData.data;
  let score = 0;
  const results = [];
  const correctAnswers = {};

quizContent.forEach(q => {
  correctAnswers[q.id] = q.correctAnswer;
})

  for (const questionId in answers) {
    const userAnswer = answers[questionId];
    const correctAnswer = correctAnswers[questionId];
    const isCorrect = userAnswer === correctAnswer;
    if (isCorrect) {
      score++;
    }
    results.push({
      questionId,
      userAnswer,
      correctAnswer,
      isCorrect
    });
  }

  const { data, error } = await supabase
    .from("progress")
    .insert([{ student_id, quiz, score, answers: results }])
    .select();

  if (error) {
    console.error("Error saving progress:", error);
  }

  res.json({ score, total: quiz.length, results });
});

app.post("/publish", async (req, res) => {
  const { subject, week,className } = req.body;

  const { data: lessons } = await supabase
    .from("lessons")
    .select("*")
    .eq("subject", subject)
    .eq("week", week);

  const { data: quizzes } = await supabase
    .from("quizzes")
    .select("*");

  const manifest = {
    subject,
    week,
    lessons,
    quizzes
  };

  const { data, error } = await supabase
    .from("manifests")
    .insert([{ subject, week, json: manifest }])
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(manifest);
});

app.get("/manifest/:subject/:week", async (req, res) => {
  const { subject, week } = req.params;
  const { data, error } = await supabase
    .from("manifests")
    .select("json")
    .eq("subject", subject)
    .eq("week", week)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return res.status(400).json({ error: error.message });
  if (data.length === 0) return res.status(404).json({ error: "Not found" });
  res.json(data[0].json);
});

app.post("/progress", async (req, res) => {
  const { student_id, quiz, answers, score } = req.body;
  const { data, error } = await supabase
    .from("progress")
    .upsert([{ student_id, quiz, answers, score }], { onConflict: "student_id,quiz" })
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
