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
            alert('Added to cart!');
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
});
