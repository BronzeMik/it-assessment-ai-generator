
import express from 'express';
import axios from 'axios';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import supabase from '../config/supabase.js';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { body, validationResult } from 'express-validator';


dotenv.config();

const app = express();


const allowedOrigins = [
    'http://localhost:8080', // Development frontend
    'https://www.betechpro.com', // Production frontend (adjust to your actual domain)
    'https://it.betechpro.com',
  ];
  
  const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204, // Ensure OPTIONS returns 204 No Content
  };

app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.use(express.json());
app.use(helmet());
app.use(morgan('combined', { skip: () => process.env.NODE_ENV === 'production' }));
app.options('*', cors(corsOptions), (req, res) => {
    res.sendStatus(204); // Respond to OPTIONS with 204
  });

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
  });
app.use('/api/generate-assessment', limiter);

// PDFMonkey API configuration
const PDFMONKEY_API_URL = 'https://api.pdfmonkey.io/api/v1/documents';
const PDFMONKEY_API_KEY = process.env.PDFMONKEY_API_KEY; // Add to .env
const TEMPLATE_ID = process.env.PDFMONKEY_TEMPLATE_ID; // From PDFMonkey dashboard

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_API_KEY = process.env.GROK_API_KEY; 



// Nodemailer configuration with PrivateEmail SMTP
const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465, // Use 465 for SSL if preferred
  secure: true, // true for 465 (SSL), false for 587 (TLS)
  auth: {
    user: process.env.EMAIL_USER, // e.g., no-reply@betechpro.com
    pass: process.env.EMAIL_PASS, // Your PrivateEmail password
  },
  tls: {
    ciphers: 'SSLv3', // Optional: Ensures compatibility with PrivateEmail
  },
});

// Verify transporter setup
transporter.verify((error, success) => {
  if (error) {
    console.error('Nodemailer verification failed:', error);
  } else {
    console.log('Nodemailer ready to send emails via PrivateEmail');
  }
});


const generateAssessment = async (formData) => {
    const prompt = `
    Generate a professional IT assessment in strict JSON format for ${formData.name} from ${formData.company}.
    - Company size: ${formData.company_size}
    - Primary IT challenge: ${formData.it_challenge}
    - Current IT setup: ${formData.it_setup || 'Not provided'}
    Return ONLY a valid JSON object (no extra text, no Markdown, no code blocks) with:
    - "company": Company name
    - "company_size": Size (e.g., "1-10")
    - "it_challenge": Primary challenge
    - "assessmentSections": Array of sections with "title" and "content":
      1. "Overview": Brief company and IT context
      2. "Challenge Analysis": Analyze the IT challenge
      3. "Recommendations": 9-10 tailored solutions
      4. "Next Steps": Call to schedule a consultation
    Keep it concise, professional, and under 300 words total.

    Example:
    {
      "company": "Tech Co",
      "company_size": "11-50",
      "it_challenge": "cybersecurity-risks",
      "assessmentSections": [
        {"title": "Overview", "content": "Tech Co is a mid-sized firm with growing IT needs."},
        {"title": "Challenge Analysis", "content": "Cybersecurity risks threaten data integrity."},
        {"title": "Recommendations", "content": [{step: 1,  action:"Deploy firewalls."}, {step: 2, action:"Train staff."}, {step: 3, action: "Audit systems."}]},
        {"title": "Next Steps", "content": "Schedule a consultation to implement solutions."}
      ]
    }
  `;

  try {
    const response = await axios.post(
      GROK_API_URL,
      {
        model: 'grok-beta',
        messages: [
          { role: 'system', content: 'You are an IT consulting expert. Return only valid JSON, no extra text.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.5, // Lower temperature for stricter output
      },
      {
        headers: {
          'Authorization': `Bearer ${GROK_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const rawContent = response.data.choices[0].message.content;

    // Clean response to extract JSON
    let jsonString = rawContent.trim();
    // Remove potential Markdown code blocks
    if (jsonString.startsWith('```json') && jsonString.endsWith('```')) {
      jsonString = jsonString.slice(7, -3).trim();
    } else if (jsonString.startsWith('```') && jsonString.endsWith('```')) {
      jsonString = jsonString.slice(3, -3).trim();
    }

    console.log(jsonString);

    // Attempt to parse JSON
    try {
      return JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Raw Grok response:', rawContent);
      // Fallback: Extract JSON-like content with regex
      const jsonMatch = rawContent.match(/{[\s\S]*}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('Unable to extract valid JSON from Grok response');
    }
  } catch (error) {
    console.error('Grok API error:', error.response?.data || error.message);
    throw new Error('Failed to generate assessment with Grok API');
  }
};
// API Endpoint
app.post('/api/generate-assessment', [
    body('formData.name').trim().isLength({ min: 1, max: 50 }).escape(),
    body('formData.email').isEmail().normalizeEmail(),
    body('formData.company').trim().isLength({ min: 1, max: 100 }).escape(),
    body('formData.company_size').isIn(['1-10', '11-50', '51-200', '200+']),
    body('formData.it_challenge').trim().isLength({ min: 1, max: 100 }).escape(),
    body('formData.it_setup').optional().trim().isLength({ max: 200 }).escape(),
    body('formData.consent').isBoolean().equals('true'),
    body('honeypot').optional(),
    body('recaptchaToken').notEmpty(),
  ], async (req, res) => {
    console.log('Incoming payload:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }


    try {
        const { formData, verificationToken, honeypot, recaptchaToken } = req.body;
        if (honeypot) {
            return res.status(403).json({ error: 'Bot detected.' });
        }
        // Verify reCAPTCHA  
        const secretKey = process.env.RECAPTCHA_SECRET_KEY;
        const recaptchaResponse = await axios.post(
            `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${recaptchaToken}`
        );
        console.log('reCAPTCHA response:', recaptchaResponse.data);
        if (!recaptchaResponse.data.success ) {
            return res.status(403).json({ error: 'Bot detected, please try again.' });
        }


        const requiredFields = ['name', 'email', 'company', 'company_size', 'it_challenge', 'consent'];
        const missingFields = requiredFields.filter(field => !formData[field]);
        if (missingFields.length > 0 || !verificationToken) {
          return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')} or verificationToken` });
        }
        if (!formData.consent) {
          return res.status(400).json({ error: 'Consent is required.' });
        }
    
        // Check Supabase for existing lead magnet
        const { data: leadMagnets, error: fetchError } = await supabase
          .from('subscribers')
          .select('lead_magnet_generated, email')
          .eq('verification_token', verificationToken);
    
        if (fetchError) {
          console.error('Supabase fetch error:', fetchError.message);
          throw new Error('Error checking subscriber data');
        }
    
        const email = leadMagnets?.[0]?.email;
        const leadMagnetData = leadMagnets?.[0]?.lead_magnet_generated || {};
    
        if (leadMagnetData['IT Assessment']) {
          const lastGeneratedTime = new Date(leadMagnetData['IT Assessment']);
          const now = new Date();
          const hoursDifference = (now - lastGeneratedTime) / (1000 * 60 * 60);
          if (hoursDifference <= 48) {
            return res.status(200).json({ message: 'Assessment already generated within 48 hours' });
          }
        }
    
        // Generate assessment with Grok
        const assessment = await generateAssessment(formData);
        console.log(assessment);

        // Update Supabase with timestamp
    const nowISO = new Date().toISOString();
    leadMagnetData['IT Assessment'] = nowISO;
    const { error: updateError } = await supabase
      .from('subscribers')
      .upsert(
        { email: formData.email, verification_token: verificationToken, lead_magnet_generated: leadMagnetData },
        { onConflict: 'email' }
      );
    if (updateError) {
      console.error('Supabase update error:', updateError.message);
      throw new Error('Error updating lead magnet timestamp');
    }

    // Generate PDF with PDFMonkey
    const pdfResponse = await axios.post(
      PDFMONKEY_API_URL,
      {
        document: {
          document_template_id: TEMPLATE_ID,
          payload: {
            name: formData.name,
            company: formData.company,
            company_size: formData.company_size,
            it_challenge: formData.it_challenge,
            it_setup: formData.it_setup || 'Not provided',
            date: new Date().toISOString().split('T')[0],
            overview: assessment.assessmentSections[0],
            challengeAnalysis: assessment.assessmentSections[1],
            recommendations: assessment.assessmentSections[2],
            nextSteps: assessment.assessmentSections[3],
          },
          status: 'pending',
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${PDFMONKEY_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const documentId = pdfResponse.data.document.id;

    // Wait for PDF to be generated
    await new Promise((resolve) => setTimeout(resolve, 20000));

    // Fetch the generated PDF URL
    const pdfUrlResponse = await axios.get(
      `https://api.pdfmonkey.io/api/v1/documents/${documentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PDFMONKEY_API_KEY}`,
        },
      }
    );


    const pdfUrl = pdfUrlResponse.data.document.download_url;


    // Send email with PrivateEmail
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: formData.email,
      subject: 'Your IT Assessment from Betechpro',
      html: `
        <p>Hi ${formData.name},</p>
        <p>Attached is your IT assessment for ${formData.company}. View it online <a href="${pdfUrl}" target="_blank">here</a> (expires in 24 hours).</p>
        <p>Schedule a free consultation: <a href="https://calendly.com/your-username/free-consultation">Book Now</a></p>
      `
    });

    res.status(200).json({
      message: 'Assessment generated and emailed successfully',
      downloadUrl: pdfUrl,
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Failed to generate or email assessment' });
  }
});

export default app;
