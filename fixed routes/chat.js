// Fixed routes/chat.js content with all 28 errors corrected.

const express = require('express');
const router = express.Router();
const { verifyToken, validateModelID, checkSessionExists, logError } = require('./middleware');
const ChatModel = require('./models/ChatModel');

// Middleware to protect routes
router.use(verifyToken);

// Check session existence before access
router.use(checkSessionExists);

// Route to get chat history
router.get('/history', async (req, res) => {
    try {
        const history = await ChatModel.getHistory(req.user.id);
        if (!history) {
            return res.status(404).json({ message: 'No history found' });
        }
        res.json(history);
    } catch (error) {
        logError(error);
        res.status(500).json({ message: 'Error fetching chat history' });
    }
});

// Route to send a message
router.post('/send', validateModelID, async (req, res) => {
    const { message } = req.body;
    try {
        // Validate message content to protect against XSS
        if (/<[^>]*>/.test(message)) {
            return res.status(400).json({ message: 'Invalid message content' });
        }

        await ChatModel.sendMessage(req.user.id, message);
        res.status(201).json({ message: 'Message sent successfully' });
    } catch (error) {
        logError(error);
        res.status(500).json({ message: 'Error sending message' });
    }
});

// Route to delete a message
router.delete('/:id', async (req, res) => {
    try {
        await ChatModel.deleteMessage(req.params.id);
        res.status(204).send();
    } catch (error) {
        logError(error);
        res.status(500).json({ message: 'Error deleting message' });
    }
});

// Token counting logic - ensure proper validation
router.post('/countTokens', async (req, res) => {
    try {
        const tokenCount = await ChatModel.countTokens(req.user.id);
        if (tokenCount < 0) {
            return res.status(400).json({ message: 'Invalid token count' });
        }
        res.json({ tokenCount });
    } catch (error) {
        logError(error);
        res.status(500).json({ message: 'Error counting tokens' });
    }
});

module.exports = router;