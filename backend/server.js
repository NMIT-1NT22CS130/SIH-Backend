const express = require('express');
const supabase = require('./db');
const multer = require('multer');
const mammoth = require('mammoth');
const path = require("path");
const fs = require("fs");
const cors = require('cors');
const axios = require("axios");
const cheerio = require('cheerio');
const app = express();

const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Enhanced HTTP client with connection management
const httpClient = axios.create({
  baseURL: 'https://translation-api-1k7k.onrender.com',
  timeout: 45000, // Increased timeout
  maxRedirects: 5,
  httpAgent: new require('http').Agent({ 
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 20,
    maxFreeSockets: 10,
    timeout: 45000
  }),
  headers: {
    'Content-Type': 'application/json',
    'Connection': 'keep-alive'
  }
});

// Improved Rate Limiter with queue system
class RateLimiter {
  constructor(maxRequests, timeWindow) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = [];
    this.queue = [];
    this.processing = false;
  }

  async wait() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const now = Date.now();
      
      // Clean old requests
      this.requests = this.requests.filter(time => now - time < this.timeWindow);
      
      if (this.requests.length < this.maxRequests) {
        const resolve = this.queue.shift();
        this.requests.push(now);
        resolve();
        
        // Small delay between requests in the same batch
        await new Promise(r => setTimeout(r, 100));
      } else {
        const oldest = this.requests[0];
        const waitTime = this.timeWindow - (now - oldest);
        await new Promise(r => setTimeout(r, waitTime + 50));
      }
    }
    
    this.processing = false;
  }
}

const translationLimiter = new RateLimiter(3, 1500); // 3 requests per 1.5 seconds

// Sequential processing instead of parallel for stability
async function translateHtmlStructureOptimized(htmlEnglish) {
  const $ = cheerio.load(htmlEnglish, { decodeEntities: false });
  
  // Collect text nodes
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

  // Process sequentially for stability
  await processSequentialTranslation(textNodes);
  
  return $.html();
}

function isOnlyNumbers(str) {
  return /^\d+$/.test(str.replace(/[.,]/g, ''));
}

async function processSequentialTranslation(textNodes) {
  const BATCH_SIZE = 1; // Process one at a time for maximum stability
  const DELAY_BETWEEN_REQUESTS = 500;
  
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < textNodes.length; i += BATCH_SIZE) {
    const batch = textNodes.slice(i, i + BATCH_SIZE);
    console.log(`Processing item ${i + 1}/${textNodes.length}`);
    
    try {
      await processBatchSequential(batch);
      successCount += batch.length;
      
      // Delay between requests
      if (i + BATCH_SIZE < textNodes.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
      }
    } catch (error) {
      console.error(`Batch failed:`, error.message);
      failCount += batch.length;
      // Continue with next items
    }
  }

  console.log(`Translation completed: ${successCount} successful, ${failCount} failed`);
}

async function processBatchSequential(batch) {
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    try {
      await translationLimiter.wait();
      
      const translated = await translateWithRetry(item.trimmedText, item.tagName, i);
      if (translated && translated.trim().length > 0) {
        item.node.data = item.originalText.replace(item.trimmedText, translated);
        console.log(`✓ Translated: "${item.trimmedText.substring(0, 30)}..."`);
      }
    } catch (error) {
      console.warn(`✗ Failed: "${item.trimmedText.substring(0, 30)}..." - ${error.message}`);
      // Keep original text on failure
    }
  }
}

async function translateWithRetry(text, tagName, index, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await translationLimiter.wait();
      
      // Stagger requests
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * 100));
      }

      const contextHint = getContextHint(tagName);
      const payload = {
        text: text,
        to: "pa",
        context: contextHint,
        preserve_formatting: true
      };

      const response = await httpClient.post("/translate", payload);
      
      if (response.data && response.data.translatedText) {
        return response.data.translatedText;
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.warn(`Attempt ${attempt}/${maxRetries} failed for: "${text.substring(0, 30)}..."`, error.message);
      
      if (attempt === maxRetries) {
        throw new Error(`All retries failed: ${error.message}`);
      }
      
      // Exponential backoff with jitter
      const baseDelay = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      const backoffTime = baseDelay + jitter;
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

app.post('/upload', upload.single("file"), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) return res.status(400).json({ error: "no file uploaded" });

    const { title, subject, week, className } = req.body;
    filePath = req.file.path;

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

    // Clean up file
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error("Error deleting file:", err);
      });
    }

    res.json({
      success: true,
      data: data[0],
      message: "Document processed successfully"
    });

  } catch (err) {
    console.error("Upload error:", err);
    
    // Clean up file on error
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        console.error("Error deleting file:", unlinkErr);
      }
    }
    
    res.status(500).json({ 
      error: "Processing failed", 
      details: err.message 
    });
  }
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

  const { data, error } = await supabase
    .from("quizzes")
    .insert([{
      class: className,
      subject,
      data: quizData,
      Week: week,
      title
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
