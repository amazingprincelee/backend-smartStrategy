import express from 'express';
import { authenticate } from '../middleware/auth.js';
import * as botController from '../controllers/botController.js';

const router = express.Router();
router.use(authenticate);

router.get('/', botController.listBots);
router.post('/', botController.createBot);
router.get('/:id', botController.getBotDetail);
router.put('/:id', botController.updateBot);
router.delete('/:id', botController.deleteBot);
router.post('/:id/start', botController.startBot);
router.post('/:id/stop', botController.stopBot);
router.get('/:id/trades', botController.getBotTrades);
router.get('/:id/positions', botController.getBotPositions);
router.get('/:id/pending-signals', botController.getPendingSignals);
router.post('/:id/execute-signal', botController.executeSignal);
router.post('/:id/positions/:positionId/close', botController.closePosition);
router.post('/quick-execute', botController.quickExecute);

export default router;
