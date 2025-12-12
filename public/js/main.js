// Cart functionality
let cart = JSON.parse(localStorage.getItem('cart')) || [];

// Update cart count in header
function updateCartCount() {
    const cartCountEl = document.getElementById('cart-count');
    if (cartCountEl) {
        const count = cart.reduce((sum, item) => sum + item.quantity, 0);
        cartCountEl.textContent = count;
    }
}

// Add to cart
function addToCart(productId, quantity = 1) {
    fetch(`/api/products/${productId}`)
        .then(res => res.json())
        .then(product => {
            const existingItem = cart.find(item => item._id === productId);
            
            if (existingItem) {
                existingItem.quantity += quantity;
            } else {
                cart.push({
                    _id: product._id,
                    name: product.name,
                    price: product.price,
                    image: product.images[0] || '',
                    quantity: quantity
                });
            }
            
            localStorage.setItem('cart', JSON.stringify(cart));
            updateCartCount();
            renderCartDrawer();
            openCartDrawer(); // Open drawer instead of alert
        })
        .catch(err => {
            console.error('Error adding to cart:', err);
            alert('Failed to add to cart');
        });
}

// Remove from cart
function removeFromCart(productId) {
    cart = cart.filter(item => item._id !== productId);
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
    renderCart();
}

// Update cart item quantity
function updateCartQuantity(productId, quantity) {
    const item = cart.find(item => item._id === productId);
    if (item) {
        item.quantity = Math.max(1, quantity);
        localStorage.setItem('cart', JSON.stringify(cart));
        updateCartCount();
        renderCart();
    }
}

// Render cart items on checkout page
function renderCart() {
    const cartItemsEl = document.getElementById('cart-items');
    const cartEmptyEl = document.getElementById('cart-empty');
    const checkoutFormSection = document.getElementById('checkout-form-section');
    
    if (!cartItemsEl) return;
    
    if (cart.length === 0) {
        cartItemsEl.style.display = 'none';
        if (cartEmptyEl) cartEmptyEl.style.display = 'block';
        if (checkoutFormSection) checkoutFormSection.style.display = 'none';
        return;
    }
    
    cartItemsEl.style.display = 'block';
    if (cartEmptyEl) cartEmptyEl.style.display = 'none';
    if (checkoutFormSection) checkoutFormSection.style.display = 'block';
    
    let html = '';
    let subtotal = 0;
    
    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        
        html += `
            <div class="cart-item">
                <div class="cart-item-image">
                    <img src="${item.image || 'https://placehold.co/100x100/f5f5f5/333333?text=No+Image'}" alt="${item.name}">
                </div>
                <div class="cart-item-info">
                    <div class="cart-item-name">${item.name}</div>
                    <div class="cart-item-price">$${item.price.toFixed(2)}</div>
                    <div class="cart-item-quantity">
                        <button onclick="updateCartQuantity('${item._id}', ${item.quantity - 1})">-</button>
                        <span>${item.quantity}</span>
                        <button onclick="updateCartQuantity('${item._id}', ${item.quantity + 1})">+</button>
                    </div>
                    <span class="cart-item-remove" onclick="removeFromCart('${item._id}')">Remove</span>
                </div>
            </div>
        `;
    });
    
    cartItemsEl.innerHTML = html;
    
    // Update summary
    const shipping = subtotal > 100 ? 0 : 9.99;
    const total = subtotal + shipping;
    
    const subtotalEl = document.getElementById('subtotal');
    const shippingEl = document.getElementById('shipping');
    const totalEl = document.getElementById('total');
    
    if (subtotalEl) subtotalEl.textContent = `$${subtotal.toFixed(2)}`;
    if (shippingEl) shippingEl.textContent = shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`;
    if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
    
    // Update hidden input for form submission
    const cartItemsInput = document.getElementById('cartItemsInput');
    if (cartItemsInput) {
        cartItemsInput.value = JSON.stringify(cart);
    }
}

// Render cart drawer items
function renderCartDrawer() {
    const drawerItems = document.getElementById('cart-drawer-items');
    const drawerEmpty = document.getElementById('cart-drawer-empty');
    const drawerFooter = document.getElementById('cart-drawer-footer');
    const drawerCount = document.getElementById('cart-drawer-count');
    const drawerSubtotal = document.getElementById('cart-drawer-subtotal');
    
    if (!drawerItems) return;
    
    // Update count in header
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    if (drawerCount) drawerCount.textContent = totalItems;
    
    if (cart.length === 0) {
        drawerItems.innerHTML = '';
        drawerEmpty.classList.add('show');
        drawerFooter.classList.add('hidden');
        return;
    }
    
    drawerEmpty.classList.remove('show');
    drawerFooter.classList.remove('hidden');
    
    let html = '';
    let subtotal = 0;
    
    cart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        
        html += `
            <div class="cart-drawer-item">
                <div class="cart-drawer-item-image">
                    <img src="${item.image || 'https://placehold.co/100x100/f5f5f5/333333?text=No+Image'}" alt="${item.name}">
                </div>
                <div class="cart-drawer-item-info">
                    <div class="cart-drawer-item-name">${item.name}</div>
                    <div class="cart-drawer-item-price">$${item.price.toFixed(2)}</div>
                    <div class="cart-drawer-item-actions">
                        <div class="cart-drawer-qty">
                            <button onclick="updateCartFromDrawer('${item._id}', ${item.quantity - 1})">−</button>
                            <span>${item.quantity}</span>
                            <button onclick="updateCartFromDrawer('${item._id}', ${item.quantity + 1})">+</button>
                        </div>
                        <button class="cart-drawer-remove" onclick="removeFromCartDrawer('${item._id}')" aria-label="Remove item">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
    });
    
    drawerItems.innerHTML = html;
    if (drawerSubtotal) drawerSubtotal.textContent = `$${subtotal.toFixed(2)}`;
}

// Update cart from drawer
function updateCartFromDrawer(productId, quantity) {
    if (quantity < 1) {
        removeFromCartDrawer(productId);
        return;
    }
    const item = cart.find(item => item._id === productId);
    if (item) {
        item.quantity = quantity;
        localStorage.setItem('cart', JSON.stringify(cart));
        updateCartCount();
        renderCartDrawer();
        renderCart(); // Also update checkout page if open
    }
}

// Remove from cart (drawer version)
function removeFromCartDrawer(productId) {
    cart = cart.filter(item => item._id !== productId);
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
    renderCartDrawer();
    renderCart(); // Also update checkout page if open
}

// Cart drawer toggle functions
function openCartDrawer() {
    const cartDrawer = document.getElementById('cart-drawer');
    const cartOverlay = document.querySelector('.cart-overlay');
    if (cartDrawer && cartOverlay) {
        cartDrawer.classList.add('active');
        cartOverlay.classList.add('active');
        document.body.classList.add('cart-open');
        renderCartDrawer();
    }
}

function closeCartDrawer() {
    const cartDrawer = document.getElementById('cart-drawer');
    const cartOverlay = document.querySelector('.cart-overlay');
    if (cartDrawer && cartOverlay) {
        cartDrawer.classList.remove('active');
        cartOverlay.classList.remove('active');
        document.body.classList.remove('cart-open');
    }
}

// Product detail page - image gallery
function initImageGallery() {
    const thumbnails = document.querySelectorAll('.thumbnail');
    const mainImage = document.getElementById('main-product-image');
    
    thumbnails.forEach(thumb => {
        thumb.addEventListener('click', () => {
            thumbnails.forEach(t => t.classList.remove('active'));
            thumb.classList.add('active');
            mainImage.src = thumb.dataset.src;
        });
    });
}

// Product detail page - quantity controls
function initQuantityControls() {
    const qtyIncrease = document.getElementById('qty-increase');
    const qtyDecrease = document.getElementById('qty-decrease');
    const qtyInput = document.getElementById('quantity');
    
    if (qtyIncrease && qtyDecrease && qtyInput) {
        qtyIncrease.addEventListener('click', () => {
            const max = parseInt(qtyInput.max) || 99;
            const current = parseInt(qtyInput.value) || 1;
            if (current < max) {
                qtyInput.value = current + 1;
            }
        });
        
        qtyDecrease.addEventListener('click', () => {
            const current = parseInt(qtyInput.value) || 1;
            if (current > 1) {
                qtyInput.value = current - 1;
            }
        });
    }
}

// Add to cart button handlers
function initAddToCartButtons() {
    // Product cards
    document.querySelectorAll('.add-to-cart').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const productId = btn.dataset.id;
            addToCart(productId, 1);
        });
    });
    
    // Product detail page
    const detailBtn = document.querySelector('.add-to-cart-detail');
    if (detailBtn) {
        detailBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const productId = detailBtn.dataset.id;
            const quantity = parseInt(document.getElementById('quantity').value) || 1;
            addToCart(productId, quantity);
        });
    }
}

// Checkout form submission
function initCheckoutForm() {
    const form = document.getElementById('checkout-form');
    if (!form) return;
    
    form.addEventListener('submit', (e) => {
        if (cart.length === 0) {
            e.preventDefault();
            alert('Your cart is empty!');
            return;
        }
        
        // Cart items are already in hidden input from renderCart()
    });
}

// Clear cart after successful order
function clearCart() {
    cart = [];
    localStorage.removeItem('cart');
    updateCartCount();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
    renderCart();
    initImageGallery();
    initQuantityControls();
    initAddToCartButtons();
    initCheckoutForm();
    
    // Check if we're on order confirmation page
    if (document.querySelector('.order-confirmation')) {
        clearCart();
    }
    
    const searchForm = document.querySelector('.header-search-expandable');
    const searchBtn = document.querySelector('.search-toggle-btn');
    const searchInput = searchForm.querySelector('.search-input');
    
    searchBtn.addEventListener('click', function(e) {
        e.preventDefault();
        searchForm.classList.toggle('active');
        
        if (searchForm.classList.contains('active')) {
            searchInput.focus();
        }
    });
    
    // Close when clicking outside
    document.addEventListener('click', function(e) {
        if (!searchForm.contains(e.target)) {
            searchForm.classList.remove('active');
        }
    });
    
    // Submit on Enter
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && searchInput.value.trim()) {
            searchForm.submit();
        }
    });
    
    // Mobile Menu Toggle
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const mobileMenuClose = document.querySelector('.mobile-menu-close');
    const mobileNav = document.querySelector('.mobile-nav');
    const mobileOverlay = document.querySelector('.mobile-menu-overlay');
    
    function openMobileMenu() {
        mobileNav.classList.add('active');
        mobileOverlay.classList.add('active');
        document.body.classList.add('menu-open');
    }
    
    function closeMobileMenu() {
        mobileNav.classList.remove('active');
        mobileOverlay.classList.remove('active');
        document.body.classList.remove('menu-open');
    }
    
    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', openMobileMenu);
    }
    
    if (mobileMenuClose) {
        mobileMenuClose.addEventListener('click', closeMobileMenu);
    }
    
    if (mobileOverlay) {
        mobileOverlay.addEventListener('click', closeMobileMenu);
    }
    
    // Close mobile menu on window resize to desktop
    window.addEventListener('resize', function() {
        if (window.innerWidth > 768) {
            closeMobileMenu();
        }
    });
    
    // Close mobile menu when clicking a link
    document.querySelectorAll('.mobile-nav-link').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });
    
    // Cart Drawer Toggle
    const cartToggleBtn = document.getElementById('cart-toggle-btn');
    const cartDrawerClose = document.querySelector('.cart-drawer-close');
    const cartOverlay = document.querySelector('.cart-overlay');
    const continueShoppingBtn = document.getElementById('continue-shopping-btn');
    
    if (cartToggleBtn) {
        cartToggleBtn.addEventListener('click', function(e) {
            e.preventDefault();
            openCartDrawer();
        });
    }
    
    if (cartDrawerClose) {
        cartDrawerClose.addEventListener('click', closeCartDrawer);
    }
    
    if (cartOverlay) {
        cartOverlay.addEventListener('click', closeCartDrawer);
    }
    
    if (continueShoppingBtn) {
        continueShoppingBtn.addEventListener('click', closeCartDrawer);
    }
    
    // Close cart drawer on Escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeCartDrawer();
        }
    });
    
    // Initial render of cart drawer
    renderCartDrawer();
    
    // ===== Product Filters Drawer =====
    const filterToggleBtn = document.getElementById('filter-toggle-btn');
    
    // Only run this code if we are on a page with filters
    if (filterToggleBtn) {
        const filtersDrawer = document.querySelector('.filters');
        const filtersOverlay = document.querySelector('.filters-overlay');
        const filtersCloseBtn = document.querySelector('.filters-close-btn');

        function openFiltersDrawer() {
            if (filtersDrawer && filtersOverlay) {
                filtersDrawer.classList.add('active');
                filtersOverlay.classList.add('active');
                document.body.classList.add('menu-open'); // Reuse class to prevent body scroll
            }
        }

        function closeFiltersDrawer() {
            if (filtersDrawer && filtersOverlay) {
                filtersDrawer.classList.remove('active');
                filtersOverlay.classList.remove('active');
                document.body.classList.remove('menu-open');
            }
        }

        filterToggleBtn.addEventListener('click', openFiltersDrawer);
        filtersCloseBtn.addEventListener('click', closeFiltersDrawer);
        filtersOverlay.addEventListener('click', closeFiltersDrawer);
        
        // Also close on Escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && filtersDrawer.classList.contains('active')) {
                closeFiltersDrawer();
            }
        });
    }
    
    // ===== Hero Carousel =====
    const heroCarousel = document.querySelector('.hero-carousel');
    
    if (heroCarousel) {
        const slides = heroCarousel.querySelectorAll('.carousel-slide');
        const dots = heroCarousel.querySelectorAll('.carousel-dot');
        const prevBtn = heroCarousel.querySelector('.carousel-prev');
        const nextBtn = heroCarousel.querySelector('.carousel-next');
        const progressBar = heroCarousel.querySelector('.carousel-progress-bar');
        
        let currentSlide = 0;
        const totalSlides = slides.length;
        const autoPlayInterval = 3000; // 3 seconds per slide
        let autoPlayTimer;
        let progressTimer;
        let progressStart;
        let isPaused = false;
        
        // Go to specific slide
        function goToSlide(index) {
            // Handle wrapping
            if (index < 0) index = totalSlides - 1;
            if (index >= totalSlides) index = 0;
            
            // Remove active class from all
            slides.forEach(slide => slide.classList.remove('active'));
            dots.forEach(dot => dot.classList.remove('active'));
            
            // Add active class to current
            slides[index].classList.add('active');
            dots[index].classList.add('active');
            
            currentSlide = index;
            
            // Reset progress bar
            resetProgress();
        }
        
        // Next slide
        function nextSlide() {
            goToSlide(currentSlide + 1);
        }
        
        // Previous slide
        function prevSlide() {
            goToSlide(currentSlide - 1);
        }
        
        // Progress bar animation
        function resetProgress() {
            if (progressBar) {
                progressBar.style.transition = 'none';
                progressBar.style.width = '0%';
                
                // Force reflow
                progressBar.offsetHeight;
                
                if (!isPaused) {
                    progressBar.style.transition = `width ${autoPlayInterval}ms linear`;
                    progressBar.style.width = '100%';
                }
            }
        }
        
        // Start auto-play
        function startAutoPlay() {
            stopAutoPlay();
            isPaused = false;
            heroCarousel.classList.remove('paused');
            resetProgress();
            
            autoPlayTimer = setInterval(() => {
                if (!isPaused) {
                    nextSlide();
                }
            }, autoPlayInterval);
        }
        
        // Stop auto-play
        function stopAutoPlay() {
            if (autoPlayTimer) {
                clearInterval(autoPlayTimer);
            }
        }
        
        // Pause carousel
        function pauseCarousel() {
            isPaused = true;
            heroCarousel.classList.add('paused');
            if (progressBar) {
                const computedWidth = getComputedStyle(progressBar).width;
                progressBar.style.transition = 'none';
                progressBar.style.width = computedWidth;
            }
        }
        
        // Resume carousel
        function resumeCarousel() {
            isPaused = false;
            heroCarousel.classList.remove('paused');
            
            if (progressBar) {
                const currentWidth = parseFloat(progressBar.style.width);
                const remainingPercent = 100 - currentWidth;
                const remainingTime = (remainingPercent / 100) * autoPlayInterval;
                
                progressBar.style.transition = `width ${remainingTime}ms linear`;
                progressBar.style.width = '100%';
            }
        }
        
        // Event Listeners
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                prevSlide();
                startAutoPlay();
            });
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                nextSlide();
                startAutoPlay();
            });
        }
        
        // Dots navigation
        dots.forEach((dot, index) => {
            dot.addEventListener('click', () => {
                goToSlide(index);
                startAutoPlay();
            });
        });
        
        // Pause on hover
        heroCarousel.addEventListener('mouseenter', pauseCarousel);
        heroCarousel.addEventListener('mouseleave', () => {
            resumeCarousel();
            // Restart timer to ensure consistent timing
            startAutoPlay();
        });
        
        // Touch/Swipe support
        let touchStartX = 0;
        let touchEndX = 0;
        
        heroCarousel.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            pauseCarousel();
        }, { passive: true });
        
        heroCarousel.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
            startAutoPlay();
        }, { passive: true });
        
        function handleSwipe() {
            const swipeThreshold = 50;
            const diff = touchStartX - touchEndX;
            
            if (Math.abs(diff) > swipeThreshold) {
                if (diff > 0) {
                    // Swipe left - next slide
                    nextSlide();
                } else {
                    // Swipe right - previous slide
                    prevSlide();
                }
            }
        }
        
        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            // Only if carousel is in viewport
            const rect = heroCarousel.getBoundingClientRect();
            const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
            
            if (isInViewport) {
                if (e.key === 'ArrowLeft') {
                    prevSlide();
                    startAutoPlay();
                } else if (e.key === 'ArrowRight') {
                    nextSlide();
                    startAutoPlay();
                }
            }
        });
        
        // Visibility change - pause when tab is hidden
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                pauseCarousel();
                stopAutoPlay();
            } else {
                startAutoPlay();
            }
        });
        
        // Initialize carousel
        startAutoPlay();
    }
});
