// ============================================
//   AstraGPT — React App (Claude.ai Style)
//   Uses React 18 via CDN + Babel standalone
// ============================================

const { useState, useEffect, useRef, useCallback } = React;

// ========== SVG Icons ==========
const Icons = {
    Star: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z" />
        </svg>
    ),
    Menu: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
        </svg>
    ),
    Plus: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    ),
    ChevronDown: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
        </svg>
    ),
    Send: () => (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
    ),
    Paperclip: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
    ),
    Copy: () => (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
    ),
    ThumbUp: () => (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
            <path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
        </svg>
    ),
    ThumbDown: () => (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z" />
            <path d="M17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17" />
        </svg>
    ),
    Refresh: () => (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
        </svg>
    ),
    History: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
    ),
    PenSquare: () => (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    ),
};

// ========== DATA ==========
const MODELS = [
    { id: 'astra-5', name: 'Astra 5', tag: 'Latest' },
    { id: 'astra-4', name: 'Astra 4', tag: null },
    { id: 'astra-mini', name: 'Astra Mini', tag: 'Fast' },
];

const SAMPLE_HISTORY = [
    { id: 1, title: 'How to build a neural network', date: 'Today' },
    { id: 2, title: 'JavaScript async/await explained', date: 'Today' },
    { id: 3, title: 'Python list comprehensions', date: 'Yesterday' },
    { id: 4, title: 'REST API design best practices', date: 'Yesterday' },
    { id: 5, title: 'React hooks deep dive', date: 'Previous 7 days' },
    { id: 6, title: 'CSS grid layout tips', date: 'Previous 7 days' },
];

const CATEGORIES = [
    { icon: '💻', label: 'Code' },
    { icon: '✍️', label: 'Write' },
    { icon: '📚', label: 'Learn' },
    { icon: '🌟', label: 'Life stuff' },
    { icon: '✦', label: "Astra's choice" },
];

// Demo AI responses for simulation
const DEMO_RESPONSES = [
    "Hello! I'm **AstraGPT**, your advanced AI assistant created by Aditya. I can help you with coding, writing, analysis, research, and much more. What would you like to explore today?",
    "Great question! Here's a detailed breakdown:\n\n1. **First**, let me analyze the context\n2. **Then**, I'll provide relevant insights\n3. **Finally**, practical recommendations\n\nThis approach ensures comprehensive coverage of your query.",
    "I understand what you're asking. Let me break this down step by step:\n\n```python\ndef astra_solution(problem):\n    # AstraGPT approach\n    analyzed = analyze(problem)\n    solution = generate_response(analyzed)\n    return solution\n```\n\nThis pattern is highly efficient for most use cases.",
    "Absolutely! AstraGPT specializes in:\n\n- **Advanced reasoning** and problem solving\n- **Code generation** in any language\n- **Creative writing** and content creation\n- **Research** and information synthesis\n- **Mathematical** computations and explanations\n\nFeel free to ask me anything!",
];

let demoIndex = 0;

function getNextResponse() {
    const r = DEMO_RESPONSES[demoIndex % DEMO_RESPONSES.length];
    demoIndex++;
    return r;
}

// ========== UTILITY ==========
function groupHistory(items) {
    const groups = {};
    items.forEach(item => {
        if (!groups[item.date]) groups[item.date] = [];
        groups[item.date].push(item);
    });
    return groups;
}

function parseMarkdown(text) {
    // Very light md parsing for the demo
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^(\d+)\.\s/gm, '<br/>$1. ')
        .replace(/^[-•]\s/gm, '<br/>• ')
        .split('\n\n').map(p => `<p>${p}</p>`).join('');
}

// ========== MODEL SELECTOR ==========
function ModelDropdown({ model, onSelect, onClose }) {
    return (
        <>
            <div className="model-dropdown-overlay" onClick={onClose} />
            <div className="model-dropdown">
                {MODELS.map(m => (
                    <div
                        key={m.id}
                        className={`model-option${model.id === m.id ? ' selected' : ''}`}
                        onClick={() => { onSelect(m); onClose(); }}
                    >
                        <div className="model-option-dot" />
                        <span className="model-option-name">{m.name}</span>
                        {m.tag && <span className="model-option-tag">{m.tag}</span>}
                    </div>
                ))}
            </div>
        </>
    );
}

// ========== SIDEBAR COMPONENT ==========
function Sidebar({ isOpen, onClose, isMobile, onNewChat, history, activeId, onSelectHistory }) {
    const grouped = groupHistory(history);

    return (
        <>
            {isMobile && isOpen && (
                <div className="sidebar-overlay visible" onClick={onClose} />
            )}
            <aside className={`sidebar${isOpen ? '' : ' hidden'}`}>
                {/* Header */}
                <div className="sidebar-header">
                    <div className="logo-area">
                        <div className="logo-icon">✦</div>
                        <span className="logo-text">Astra<span>GPT</span></span>
                    </div>
                    <button className="sidebar-toggle-btn" onClick={onClose} title="Close sidebar">
                        <Icons.Menu />
                    </button>
                </div>

                {/* New Chat */}
                <button className="new-chat-btn" onClick={onNewChat}>
                    <Icons.Plus />
                    <span>New chat</span>
                </button>

                {/* History */}
                <nav className="chat-history">
                    {Object.entries(grouped).map(([date, items]) => (
                        <div key={date}>
                            <div className="history-section-title">{date}</div>
                            {items.map(item => (
                                <div
                                    key={item.id}
                                    className={`history-item${item.id === activeId ? ' active' : ''}`}
                                    onClick={() => onSelectHistory(item.id)}
                                >
                                    <span>{item.title}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </nav>

                {/* Footer */}
                <div className="sidebar-footer">
                    <div className="upgrade-banner">
                        <div className="upgrade-banner-title">✦ Upgrade to AstraGPT Pro</div>
                        <div className="upgrade-banner-sub">Unlock powerful models & features</div>
                    </div>
                    <button className="user-profile-btn">
                        <div className="user-avatar">A</div>
                        <div className="user-info">
                            <div className="user-name">Aditya</div>
                            <div className="user-plan">Free plan</div>
                        </div>
                    </button>
                </div>
            </aside>
        </>
    );
}

// ========== WELCOME SCREEN ==========
function WelcomeScreen() {
    return (
        <div className="welcome-screen">
            <div className="welcome-badge">
                <div className="welcome-badge-dot" />
                <span>Free plan</span>
                <span>•</span>
                <a href="#">Upgrade</a>
            </div>
            <div className="welcome-icon-wrap">
                <span className="welcome-star-icon">✦</span>
            </div>
            <h1 className="welcome-title">Hey there, Aditya</h1>
        </div>
    );
}

// ========== TYPING INDICATOR ==========
function TypingIndicator() {
    return (
        <div className="typing-indicator">
            <div className="typing-inner">
                <div className="ai-avatar">✦</div>
                <div className="typing-dots">
                    <div className="dot" />
                    <div className="dot" />
                    <div className="dot" />
                </div>
            </div>
        </div>
    );
}

// ========== MESSAGE COMPONENT ==========
function Message({ msg }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(msg.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    if (msg.role === 'user') {
        return (
            <div className="message-row user-row">
                <div className="user-bubble">{msg.text}</div>
            </div>
        );
    }

    return (
        <div className="message-row ai-row">
            <div className="ai-message-wrap">
                <div className="ai-avatar">✦</div>
                <div className="ai-bubble" dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }} />
            </div>
            <div className="message-actions">
                <button className="action-pill" onClick={handleCopy} title="Copy">
                    <Icons.Copy /> {copied ? 'Copied!' : 'Copy'}
                </button>
                <button className="action-pill" title="Good response"><Icons.ThumbUp /></button>
                <button className="action-pill" title="Bad response"><Icons.ThumbDown /></button>
                <button className="action-pill" title="Regenerate"><Icons.Refresh /> Retry</button>
            </div>
        </div>
    );
}

// ========== MAIN APP ==========
function App() {
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [model, setModel] = useState(MODELS[0]);
    const [showModelDrop, setShowModelDrop] = useState(false);
    const [history, setHistory] = useState(SAMPLE_HISTORY);
    const [activeHistoryId, setActiveHistoryId] = useState(null);

    const textareaRef = useRef(null);
    const chatEndRef = useRef(null);
    const modelBtnRef = useRef(null);

    // Handle resize
    useEffect(() => {
        const onResize = () => {
            const mobile = window.innerWidth < 1024;
            setIsMobile(mobile);
            if (!mobile) setSidebarOpen(true);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Close sidebar on mobile by default
    useEffect(() => {
        if (isMobile) setSidebarOpen(false);
    }, [isMobile]);

    // Auto scroll
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    // Auto resize textarea
    const handleInput = (e) => {
        const t = e.target;
        setInputText(t.value);
        t.style.height = 'auto';
        t.style.height = Math.min(t.scrollHeight, 200) + 'px';
    };

    const sendMessage = useCallback(async (text) => {
        if (!text.trim()) return;

        const userMsg = { id: Date.now(), role: 'user', text: text.trim() };
        setMessages(prev => [...prev, userMsg]);
        setInputText('');
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
        setIsTyping(true);

        // Simulate AI response delay
        const delay = 1200 + Math.random() * 800;
        await new Promise(r => setTimeout(r, delay));

        const aiMsg = {
            id: Date.now() + 1,
            role: 'ai',
            text: getNextResponse(),
        };
        setIsTyping(false);
        setMessages(prev => [...prev, aiMsg]);
    }, []);

    const handleSend = () => sendMessage(inputText);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isTyping) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleNewChat = () => {
        setMessages([]);
        setActiveHistoryId(null);
        if (isMobile) setSidebarOpen(false);
    };

    const handleCategoryClick = (label) => {
        const prompts = {
            'Code': 'Help me write a Python function that',
            'Write': 'Write a compelling story about',
            'Learn': 'Explain in simple terms:',
            'Life stuff': 'Give me advice on',
            "Astra's choice": "Surprise me with something interesting!",
        };
        setInputText(prompts[label] || label);
        textareaRef.current?.focus();
    };

    const showWelcome = messages.length === 0;
    const canSend = inputText.trim().length > 0 && !isTyping;

    return (
        <div className="app-layout">
            {/* SIDEBAR */}
            <Sidebar
                isOpen={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                isMobile={isMobile}
                onNewChat={handleNewChat}
                history={history}
                activeId={activeHistoryId}
                onSelectHistory={(id) => {
                    setActiveHistoryId(id);
                    if (isMobile) setSidebarOpen(false);
                }}
            />

            {/* MAIN */}
            <div className="main-content">
                {/* TOP BAR */}
                <div className="top-bar">
                    <div className="top-bar-left">
                        <button
                            className="menu-btn"
                            onClick={() => setSidebarOpen(v => !v)}
                            title="Toggle sidebar"
                        >
                            <Icons.Menu />
                        </button>

                        {/* Model Selector */}
                        <div style={{ position: 'relative' }}>
                            <button
                                ref={modelBtnRef}
                                className="model-selector-btn"
                                onClick={() => setShowModelDrop(v => !v)}
                            >
                                <span>{model.name}</span>
                                <Icons.ChevronDown />
                            </button>
                            {showModelDrop && (
                                <ModelDropdown
                                    model={model}
                                    onSelect={setModel}
                                    onClose={() => setShowModelDrop(false)}
                                />
                            )}
                        </div>
                    </div>

                    <div className="top-bar-right">
                        <button className="icon-btn" title="New chat" onClick={handleNewChat}>
                            <Icons.PenSquare />
                        </button>
                    </div>
                </div>

                {/* CHAT AREA */}
                <div className="chat-area">
                    {showWelcome ? (
                        <WelcomeScreen />
                    ) : (
                        <div className="messages-container">
                            {messages.map(msg => (
                                <Message key={msg.id} msg={msg} />
                            ))}
                            {isTyping && <TypingIndicator />}
                            <div ref={chatEndRef} />
                        </div>
                    )}
                </div>

                {/* INPUT AREA */}
                <div className="input-area">
                    <div className="input-box">
                        <textarea
                            ref={textareaRef}
                            className="input-textarea"
                            placeholder="How can I help you today?"
                            value={inputText}
                            onChange={handleInput}
                            onKeyDown={handleKeyDown}
                            rows={1}
                            disabled={isTyping}
                        />
                        <div className="input-bottom-row">
                            {/* Category Pills */}
                            <div className="category-pills">
                                {CATEGORIES.map(cat => (
                                    <button
                                        key={cat.label}
                                        className="pill-btn"
                                        onClick={() => handleCategoryClick(cat.label)}
                                    >
                                        <span>{cat.icon}</span>
                                        <span>{cat.label}</span>
                                    </button>
                                ))}
                            </div>

                            {/* Right side buttons */}
                            <div className="input-right-row">
                                <button className="attach-btn" title="Attach file">
                                    <Icons.Paperclip />
                                </button>
                                <button
                                    className="send-btn"
                                    onClick={handleSend}
                                    disabled={!canSend}
                                    title="Send message"
                                >
                                    <Icons.Send />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="input-footer-text">
                        AstraGPT can make mistakes. Consider checking important information.
                    </div>
                </div>
            </div>
        </div>
    );
}

// ========== MOUNT ==========
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
