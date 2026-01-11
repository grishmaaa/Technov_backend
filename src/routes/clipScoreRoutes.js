import express from 'express';
import multer from 'multer';
import { clipScoreController } from '../controllers/clipScoreController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/clip-score', upload.single('file'), clipScoreController);

export default router;
